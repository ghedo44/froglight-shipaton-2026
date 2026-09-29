import { publishSurfaceObjects } from './transactions.js';
/**
 * Surface interaction controller.
 *
 * Host-free gesture semantics: normalized input events in view space
 * produce model mutations (translate/resize/rotate) and ephemeral
 * camera changes (pan/zoom). Providers bind DOM events onto this API;
 * selection lives here, never in canonical data. No history ownership —
 * undo/redo stays provider-local.
 */

import { ErrorCodes, FroglightError } from '../errors.js';
import {
  SURFACE_MAX_COORDINATE,
  SURFACE_OBJECT_TYPES,
  lineObject,
  type ConnectorAnchor,
  type SurfaceModel,
  type SurfaceObjectId,
  type SurfaceObjectRecord,
} from './model.js';
import {
  createCamera,
  finiteNumber,
  pointInRotatedBounds,
  rotatedBoundsAabb,
  viewToSurface,
  zoomCameraAt,
  type Bounds,
  type Camera,
  type Point,
} from './geometry.js';
import {
  groupOfMember,
  inkInteractionRecord,
  looseEnvelopeBounds,
  maxStrokeHalfWidth,
  resolveGroupMembers,
  rotationOf,
  INK_DEFAULT_WIDTH,
  INK_HIT_TOLERANCE,
} from './objects.js';
import type { SurfaceObjectTypeRegistry } from './registry.js';
import { anchorPoint, resolveConnectorAnchor } from './ink/connectors.js';
import { computeSnap, SNAP_GUIDE_COLOR, type SnapGuide } from './snap.js';
import type { DrawItem } from './draw.js';
import { SurfaceSpatialIndex, expandBounds } from './spatial-index.js';
import { ConnectorReverseIndex } from './connector-index.js';
import { SurfaceDerivedGeometryStore } from './derived-store.js';
import { isBoundsLike } from './open-metadata.js';
import { selectionBoundsFor, selectionHandles } from './selection.js';
import type { SelectionDragSession } from './selection-drag.js';
import {
  invalidateCompiledForIds,
  captureGeometryOwnershipForIds,
  accumulateDerivedTranslation,
} from './objects.js';

/**
 * Provider-normalized pointer event. `point` is in view coordinates.
 * The optional hardware axes are absent for mouse/touchpad pointers;
 * consumers treat absence as "no data", never as a zero value.
 */
export interface NormalizedPointerEvent {
  readonly point: Point;
  readonly shift?: boolean;
  /** Normalized pen pressure, 0–1, when the provider supplies it. */
  readonly pressure?: number;
  /** Pen tilt vector away from normal, in radians, when available. */
  readonly tilt?: { readonly x: number; readonly y: number };
  /** Pen barrel rotation, radians −π–π, when available. */
  readonly twist?: number;
  /**
   * Monotonic event time in milliseconds (DOMHighResTimeStamp basis),
   * when the provider supplies it. Capture stamps `dt` deltas from it;
   * absence means "no data", never zero.
   */
  readonly time?: number;
}

/**
 * One provider-normalized input batch (writing-experience input model):
 * every sample was normalized against a single geometry read and keeps
 * temporal order. `confirmed` feeds canonical capture; `predicted` is an
 * ephemeral lookahead that must never commit, persist, or mark dirty.
 */
export interface InkInputBatch {
  readonly confirmed: readonly NormalizedPointerEvent[];
  readonly predicted: readonly NormalizedPointerEvent[];
}

/** Provider-normalized wheel event; explicit `factor` overrides deltaY. */
export interface NormalizedWheelEvent {
  readonly point: Point;
  readonly deltaY?: number;
  readonly factor?: number;
}

export interface SurfaceInteractionControllerOptions {
  readonly model: SurfaceModel;
  readonly registry: SurfaceObjectTypeRegistry;
  /** Initial camera; defaults to the identity view. */
  readonly camera?: Camera;
  /** Optional product-configured zoom clamps. */
  readonly minZoom?: number;
  readonly maxZoom?: number;
  /** Base for the default deltaY-derived zoom factor (1.1 per 100px). */
  readonly wheelZoomBase?: number;
  /** Invoked after each mutation batch with the mutated object ids. */
  readonly onMutate?: (mutatedIds: readonly SurfaceObjectId[]) => void;
  /**
   * Mutation-recorder seam for patch history: invoked BEFORE each
   * mutation batch with the ids about to change, so the provider can
   * capture BEFORE images without scanning unchanged strokes.
   */
  readonly onBeforeMutate?: (mutatedIds: readonly SurfaceObjectId[]) => void;
  /**
   * Command-history seam for pure translations (Slice 3): invoked INSTEAD
   * of `onBeforeMutate` when a drag/commit is a pure translation, so the
   * provider can record `{ids,dx,dy}` without cloning sample arrays.
   * When absent, translation commits fall back to `onBeforeMutate`.
   */
  readonly onBeforeTranslate?: (
    ids: readonly SurfaceObjectId[],
    dx: number,
    dy: number,
  ) => void;
  /**
   * Snap threshold in view units (default 8); 0 or omitted disables
   * alignment snapping. Surface threshold derives per gesture zoom.
   */
  readonly snapThresholdView?: number;
  /**
   * Ephemeral snap guides for the active drag (possibly empty). Fired on
   * every translating event; providers render them as preview overlays.
   * Never canonical, never dirty.
   */
  readonly onSnapGuides?: (guides: readonly DrawItem[]) => void;
  /** Fresh ids for quick-connect materialization; uniqueness suffices. */
  readonly idFactory?: () => SurfaceObjectId;
}

/** Structural counters for large-selection / open scalability gates. */
export interface SurfaceControllerStats {
  /** Bounds computations (registry.boundsOf calls). */
  boundsComputations: number;
  /** Static snap candidates examined (indexed, not full-model). */
  snapCandidatesScanned: number;
  /** Connector records examined during reconciliation. */
  connectorRecordsScanned: number;
  /** Canonical Ink samples mutated (translate/resize/rotate writes). */
  canonicalSamplesMutated: number;
  /**
   * Canonical Ink samples moved by rigid translation (item 1): the single
   * O(samples) point rewrite on commit, measured separately from geometry
   * mutations. Derived bounds/compiled geometry for these samples must
   * NOT rescan or recompile (see `translationCommits`).
   */
  canonicalSamplesTranslated: number;
  /**
   * Cumulative milliseconds spent rewriting canonical points in rigid
   * translation commits (the O(samples) pointer-up rewrite, measured
   * separately so its real cost stays visible after derived work went
   * O(1)). Wall-clock for diagnostics only — never a CI gate.
   */
  canonicalTranslateMs: number;
  /**
   * Cumulative milliseconds spent shifting derived state in rigid
   * translation commits (transform accumulation + bounds + spatial, no
   * recompiles). Diagnostics only.
   */
  derivedTranslateMs: number;
  /** Ephemeral drag moves (no canonical mutation). */
  ephemeralMoves: number;
  /** Canonical drag commits (exactly one per drag). */
  dragCommits: number;
  /** Geometry-preserving translation commits (no recompiles, no rescans). */
  translationCommits: number;
  /** Derived bounds entries shifted by translation (no point scans). */
  translatedBoundsUpdates: number;
  /**
   * Decode-time bounds seeds consumed by `seedIndexesFromDecode`
   * (no sample scans for these ids). Fallbacks still surface as
   * `boundsComputations`.
   */
  seedBoundsSeeded: number;
}

/** Default per-100px wheel zoom multiplier; override via `wheelZoomBase`. */
export const DEFAULT_WHEEL_ZOOM_BASE = 1.1;

/** Edges and centers for `alignSelection`. */
export type AlignEdge =
  | 'left'
  | 'centerX'
  | 'right'
  | 'top'
  | 'centerY'
  | 'bottom';

/** Axis for `distributeSelection`. */
export type DistributeAxis = 'x' | 'y';

interface DragBaseline {
  readonly startSurface: Point;
  /** Start origin per id; null when the type translates itself. */
  readonly origins: ReadonlyMap<SurfaceObjectId, Point | null>;
  /** Ephemeral surface-space translation (NOT yet applied to canonical). */
  applied: Point;
  /** Union bounds at drag start (computed once, translated per frame). */
  readonly startBounds: Bounds | null;
  /** Moving ids in paint order (for session + commit). */
  readonly movingIds: readonly SurfaceObjectId[];
}

/** Connector endpoint drag: rebind or free-move one bound end. */
interface EndpointDrag {
  readonly kind: 'endpoint';
  readonly id: SurfaceObjectId;
  readonly end: 'source' | 'target';
  readonly startSurface: Point;
  readonly origBinding: unknown;
  readonly origX: number;
  readonly origY: number;
}

/**
 * Quick-connect drag from a shape anchor: creates a bound connector on
 * first real movement, optionally materializing a card on empty drops.
 */
interface ConnectDrag {
  readonly kind: 'connect';
  readonly fromId: SurfaceObjectId;
  readonly fromAnchor: ConnectorAnchor;
  readonly startView: Point;
  connectorId: SurfaceObjectId | null;
  moved: boolean;
}

type DragState =
  | ({ readonly kind: 'move' } & DragBaseline)
  | EndpointDrag
  | ConnectDrag;

/** View-space grab radius for handles and connector endpoints. */
export const HANDLE_GRAB_RADIUS_VIEW = 10;

/** View-space drag distance before a connect gesture materializes. */
const CONNECT_DRAG_THRESHOLD_VIEW = 4;

export class SurfaceInteractionController {
  readonly #model: SurfaceModel;
  readonly #registry: SurfaceObjectTypeRegistry;
  readonly #minZoom: number | null;
  readonly #maxZoom: number | null;
  readonly #onMutate: ((ids: readonly SurfaceObjectId[]) => void) | null;
  readonly #onBeforeMutate: ((ids: readonly SurfaceObjectId[]) => void) | null;
  readonly #onBeforeTranslate:
    | ((ids: readonly SurfaceObjectId[], dx: number, dy: number) => void)
    | null;
  readonly #wheelZoomBase: number;
  readonly #snapThresholdView: number;
  readonly #onSnapGuides: ((guides: readonly DrawItem[]) => void) | null;
  #camera: Camera;
  #selection: SurfaceObjectId[] = [];
  #drag: DragState | null = null;
  #destroyed = false;
  #idCounter = 0;
  readonly #idFactory: () => SurfaceObjectId;
  /** True while a non-empty guide set is published (clear exactly once). */
  #guidesOut = false;
  /** Model-local spatial index (built lazily, updated on mutation). */
  readonly #spatialIndex = new SurfaceSpatialIndex();
  /** Reverse connector index (built lazily, updated on mutation). */
  readonly #connectorIndex = new ConnectorReverseIndex();
  /** Derived bounds cache (explicit invalidation, no fingerprint scans). */
  readonly #derived = new SurfaceDerivedGeometryStore();
  #indexesBuilt = false;
  /**
   * Conservative hit-test reach in surface units: max over indexed records
   * of (per-type hit threshold). Grows monotonically between rebuilds
   * (overlarge only adds candidates, never drops hits).
   */
  #maxHitPad = 0;
  /** Canonical mutation generation: cache-buster for selection chrome. */
  #modelGeneration = 0;
  #selectionBoundsCache: {
    key: string;
    generation: number;
    bounds: Bounds | null;
  } | null = null;
  readonly #stats: SurfaceControllerStats = {
    boundsComputations: 0,
    snapCandidatesScanned: 0,
    connectorRecordsScanned: 0,
    canonicalSamplesMutated: 0,
    canonicalSamplesTranslated: 0,
    canonicalTranslateMs: 0,
    derivedTranslateMs: 0,
    ephemeralMoves: 0,
    dragCommits: 0,
    translationCommits: 0,
    translatedBoundsUpdates: 0,
    seedBoundsSeeded: 0,
  };

  constructor(options: SurfaceInteractionControllerOptions) {
    this.#model = options.model;
    this.#registry = options.registry;
    this.#camera = options.camera ?? createCamera();
    this.#minZoom = options.minZoom ?? null;
    this.#maxZoom = options.maxZoom ?? null;
    this.#wheelZoomBase = options.wheelZoomBase ?? DEFAULT_WHEEL_ZOOM_BASE;
    this.#onMutate = ids => { publishSurfaceObjects(this.#model, ids); options.onMutate?.(ids); };
    this.#onBeforeMutate = options.onBeforeMutate ?? null;
    this.#onBeforeTranslate = options.onBeforeTranslate ?? null;
    this.#idFactory =
      options.idFactory ??
      (() => {
        this.#idCounter += 1;
        return `surface-${this.#idCounter}-${Math.random().toString(36).slice(2, 8)}`;
      });
    this.#snapThresholdView =
      typeof options.snapThresholdView === 'number' &&
      Number.isFinite(options.snapThresholdView) &&
      options.snapThresholdView > 0
        ? options.snapThresholdView
        : 0;
    this.#onSnapGuides = options.onSnapGuides ?? null;
  }

  /** Mutation-recorder hook: capture BEFORE images before first change. */
  #before(ids: readonly SurfaceObjectId[]): void {
    if (ids.length === 0) return;
    captureGeometryOwnershipForIds(this.#model, ids);
    this.#onBeforeMutate?.(ids);
  }

  /** Structural counters (scalability gates). */
  controllerStats(): SurfaceControllerStats {
    return { ...this.#stats };
  }

  spatialIndexStats(): import('./spatial-index.js').SurfaceSpatialIndexStats {
    return this.#spatialIndex.statsSnapshot();
  }

  connectorIndexStats(): import('./connector-index.js').ConnectorIndexStats {
    return this.#connectorIndex.statsSnapshot();
  }

  derivedStats(): import('./derived-store.js').DerivedStoreStats {
    return this.#derived.statsSnapshot();
  }

  /** Ensure model-local indexes reflect the current model (once per open). */
  ensureIndexes(): void {
    if (this.#indexesBuilt) return;
    this.rebuildIndexes();
  }

  /** Full rebuild (decode/open or external bulk load). */
  rebuildIndexes(): void {
    this.#spatialIndex.clear();
    this.#maxHitPad = 0;
    for (const id of this.#model.order) {
      const record = this.#model.objects[id];
      if (record === undefined) continue;
      const bounds = this.#cachedBoundsOf(record);
      if (bounds !== null) this.#spatialIndex.insert(id, this.#indexedBounds(record, bounds));
      this.#maxHitPad = Math.max(this.#maxHitPad, hitPadFor(record));
    }
    this.#connectorIndex.rebuild(this.#model);
    this.#indexesBuilt = true;
  }

  /**
   * Seeded rebuild from decode (item 5): install `seedBounds` (computed
   * during the decode pass) directly into derived + spatial indexes
   * without rescanning Ink samples. Non-seeded ids (non-Ink, or records
   * created after decode) fall back to the single cheap computation.
   * Malformed entries (non-finite, negative sizes) fall back per id —
   * stale seeds are never trusted silently. Derived-only — canonical
   * content is untouched.
   */
  seedIndexesFromDecode(seedBounds: ReadonlyMap<string, Bounds | null>): void {
    this.#spatialIndex.clear();
    this.#maxHitPad = 0;
    for (const id of this.#model.order) {
      const record = this.#model.objects[id];
      if (record === undefined) continue;
      this.#maxHitPad = Math.max(this.#maxHitPad, hitPadFor(record));
      if (seedBounds.has(id)) {
        const seeded = seedBounds.get(id) ?? null;
        if (seeded === null || isBoundsLike(seeded)) {
          this.#derived.seed(record, seeded);
          if (seeded !== null) this.#spatialIndex.insert(id, this.#indexedBounds(record, seeded));
          this.#stats.seedBoundsSeeded += 1;
          continue;
        }
        // Malformed seed for a live id: fall through to derivation.
      }
      const bounds = this.#cachedBoundsOf(record);
      if (bounds !== null) this.#spatialIndex.insert(id, this.#indexedBounds(record, bounds));
    }
    this.#connectorIndex.rebuild(this.#model);
    this.#indexesBuilt = true;
  }

  /** Cached bounds (O(1) hit, cheap raw scan on miss, counted). */
  #cachedBoundsOf(record: SurfaceObjectRecord): Bounds | null {
    // Derived-store fast path: same ref → O(1), no sample scan.
    const cached = this.#derived.cachedBounds(record, (rec) => {
      this.#stats.boundsComputations += 1;
      try {
        return this.#registry.get(rec.type)?.boundsOf?.(rec) ?? null;
      } catch {
        return null;
      }
    });
    return cached === null ? null : { ...cached };
  }

  /** Spatial queries use world bounds; exact predicates retain local pivots. */
  #indexedBounds(record: SurfaceObjectRecord, local: Bounds): Bounds {
    // Text targets must remain discoverable when their local box rotates.
    if (record.type === SURFACE_OBJECT_TYPES.text && rotationOf(record) !== 0)
      return rotatedBoundsAabb(local, rotationOf(record));
    if (record.type !== SURFACE_OBJECT_TYPES.stroke || rotationOf(record) === 0) return local;
    const source = inkInteractionRecord(this.#model, record);
    return rotatedBoundsAabb(this.#cachedBoundsOf(source) ?? local, rotationOf(source));
  }

  #indexInsert(id: string): void {
    const record = this.#model.objects[id];
    if (record === undefined) {
      this.#spatialIndex.remove(id);
      this.#derived.remove(id);
      this.#connectorIndex.removeObject(id);
      return;
    }
    // Invalidate first so the recompute below cannot serve stale bounds
    // (reconciled followers arrive here without a prior invalidate).
    this.#derived.invalidate([id]);
    this.#maxHitPad = Math.max(this.#maxHitPad, hitPadFor(record));
    const bounds = this.#cachedBoundsOf(record);
    // Invalidate first (ref changed → miss → recompute above already did),
    // then insert fresh bounds. The derived cache already holds the new
    // bounds; the spatial index needs the explicit update.
    if (bounds !== null) this.#spatialIndex.update(id, this.#indexedBounds(record, bounds));
    else this.#spatialIndex.remove(id);
    this.#connectorIndex.syncConnector(id, record);
  }

  #indexMutated(ids: readonly SurfaceObjectId[]): void {
    // Mutated records changed ref or content: #indexInsert drops each
    // id's derived bounds so the next read recomputes once, then refreshes
    // the spatial + connector indexes. Compiled Ink geometry for the same
    // refs is stale → invalidate.
    try {
      invalidateCompiledForIds(this.#model, ids);
    } catch {
      // Invalidation never breaks mutation.
    }
    for (const id of ids) this.#indexInsert(id);
    this.#modelGeneration += 1;
  }

  /**
   * Geometry-preserving translation index update (item 1): for pure rigid
   * translations, shift derived bounds and compiled Ink geometry by
   * `(dx,dy)` instead of rescanning samples or recompiling. Explicitly
   * distinct from `#indexMutated()` (geometry mutation). Call AFTER the
   * canonical point rewrite; the rewrite itself is counted separately as
   * `canonicalSamplesTranslated`.
   */
  #indexTranslated(
    ids: readonly SurfaceObjectId[],
    dx: number,
    dy: number,
  ): void {
    if (ids.length === 0 || (dx === 0 && dy === 0)) return;
    this.ensureIndexes();
    // Preserve compiled Ink geometry without copying it: the cached
    // geometry stays immutable in local coordinates and the translation
    // accumulates as derived metadata (no `compileInkStroke` on release,
    // no vertex copies — see `accumulateDerivedTranslation`).
    try {
      accumulateDerivedTranslation(this.#model, ids, dx, dy);
    } catch {
      // Translation never breaks mutation; worst case the next demand
      // compile rebuilds from translated canonical samples.
    }
    // Shift derived bounds (no raw-point rescans).
    const shifted = this.#derived.translateMany(ids, dx, dy);
    this.#stats.translatedBoundsUpdates += shifted;
    // Fallback for ids with no cached bounds (first touch): single miss
    // scan each, then spatial update. No second scan, no recompile.
    for (const id of ids) {
      const record = this.#model.objects[id];
      if (record === undefined) {
        this.#spatialIndex.remove(id);
        this.#derived.remove(id);
        this.#connectorIndex.removeObject(id);
        continue;
      }
      this.#maxHitPad = Math.max(this.#maxHitPad, hitPadFor(record));
      const cached = this.#spatialIndex.getBounds(id);
      if (cached !== null) {
        this.#spatialIndex.update(id, {
          x: cached.x + dx,
          y: cached.y + dy,
          width: cached.width,
          height: cached.height,
        });
      } else {
        // No spatial entry yet: compute once via the derived cache (one
        // scan) and insert. Derived.translate above missed, so this is
        // the single miss path — still no recompile.
        const bounds = this.#cachedBoundsOf(record);
        if (bounds !== null) this.#spatialIndex.update(id, this.#indexedBounds(record, bounds));
        else this.#spatialIndex.remove(id);
      }
      this.#connectorIndex.syncConnector(id, record);
    }
    this.#stats.translationCommits += 1;
    this.#modelGeneration += 1;
  }

  /**
   * Explicit rigid-translation notification (item 1): update spatial and
   * derived caches by `(dx,dy)` without geometry invalidation. For
   * external callers (undo/redo of `TranslateObjectsCommand`, provider
   * direct translates) that already rewrote canonical points. Never call
   * this for geometry mutations — use `notifyExternalMutation` there.
   */
  notifyTranslated(
    ids: readonly SurfaceObjectId[],
    dx: number,
    dy: number,
  ): void {
    if (ids.length === 0 || (dx === 0 && dy === 0)) return;
    this.#indexTranslated(ids, dx, dy);
  }

  /**
   * Derived-only translation for callers that mutated canonical points
   * themselves but want the same no-rescan guarantee (item 1 seam).
   * Equivalent to `notifyTranslated`; kept as a named alias for the
   * `translateDerived(...)` API requested in the repair brief.
   */
  translateDerived(
    ids: readonly SurfaceObjectId[],
    dx: number,
    dy: number,
  ): void {
    this.notifyTranslated(ids, dx, dy);
  }

  /**
   * External mutation hook (undo/redo, provider direct writes, tool
   * context commits): refresh spatial/connector/derived caches for ids
   * without a full rebuild. Call after any canonical change that bypassed
   * this controller's own commit paths.
   */
  notifyExternalMutation(ids: readonly SurfaceObjectId[]): void {
    if (ids.length === 0) return;
    this.ensureIndexes();
    this.#indexMutated(ids);
  }

  /**
   * Indexed connector reconciliation for external callers (tools,
   * providers): only connectors bound to moved ids, never a full scan.
   * Updates indexes for reconciled followers and returns their ids.
   */
  reconcileConnectors(
    movedIds: readonly SurfaceObjectId[],
  ): readonly SurfaceObjectId[] {
    if (movedIds.length === 0) return [];
    const reconciled = this.#reconcileViaIndex(movedIds);
    if (reconciled.length > 0) this.#indexMutated(reconciled);
    return reconciled;
  }

  // --- Ephemeral state readers (safe after destroy) ---

  selection(): readonly SurfaceObjectId[] {
    return [...this.#selection];
  }

  camera(): Camera {
    return { ...this.#camera };
  }

  /** Replace the ephemeral viewport mapping (never canonical data). */
  setCamera(camera: Camera): void {
    this.#assertAlive();
    this.#camera = { ...camera };
  }

  isDragging(): boolean {
    return this.#drag !== null;
  }

  /**
   * Ephemeral selection drag session (Slice 1): null when idle.
   * Renderers draw cached selection geometry translated by `delta`
   * without touching canonical records.
   */
  selectionDrag(): SelectionDragSession | null {
    const drag = this.#drag;
    if (drag === null || drag.kind !== 'move') return null;
    const moving = new Set(drag.movingIds);
    const followers: DrawItem[] = [];
    for (const id of this.#connectorIndex.connectorsFor(drag.movingIds)) {
      if (moving.has(id)) continue;
      const record = this.#model.objects[id];
      if (record === undefined) continue;
      const preview = { ...record };
      for (const end of ['source', 'target'] as const) {
        const binding = record[end] as { objectId?: string } | undefined;
        if (binding?.objectId === undefined || !moving.has(binding.objectId))
          continue;
        const x = end === 'source' ? 'x' : 'x2';
        const y = end === 'source' ? 'y' : 'y2';
        preview[x] = Number(record[x]) + drag.applied.x;
        preview[y] = Number(record[y]) + drag.applied.y;
      }
      const item = this.#registry.get(record.type)?.compile?.(preview);
      if (item != null && !Array.isArray(item))
        followers.push(item as DrawItem);
    }
    return {
      followers,
      logicalIds: [...drag.movingIds],
      startSurface: { ...drag.startSurface },
      delta: { ...drag.applied },
      startBounds: drag.startBounds === null ? null : { ...drag.startBounds },
    };
  }

  /** Current ephemeral delta (zero when idle). */
  dragDelta(): Point {
    const drag = this.#drag;
    if (drag === null || drag.kind !== 'move') return { x: 0, y: 0 };
    return { ...drag.applied };
  }

  /** Union bounds translated by the ephemeral delta (cheap chrome). */
  dragTranslatedBounds(): Bounds | null {
    const drag = this.#drag;
    if (drag === null || drag.kind !== 'move') return null;
    if (drag.startBounds === null) return null;
    return {
      x: drag.startBounds.x + drag.applied.x,
      y: drag.startBounds.y + drag.applied.y,
      width: drag.startBounds.width,
      height: drag.startBounds.height,
    };
  }

  /**
   * Cached union bounds of the current selection (Slice 10): computed once
   * per selection/generation, then O(1). Lets selection chrome and pan
   * frames avoid rescanning every selected stroke's samples per render.
   */
  selectionBoundsCached(): Bounds | null {
    const key = this.#selection.join('\n');
    const cached = this.#selectionBoundsCache;
    if (
      cached !== null &&
      cached.key === key &&
      cached.generation === this.#modelGeneration
    ) {
      return cached.bounds === null ? null : { ...cached.bounds };
    }
    const union = this.#unionBoundsFor(this.#selection);
    this.#selectionBoundsCache = {
      key,
      generation: this.#modelGeneration,
      bounds: union === null ? null : { ...union },
    };
    return union;
  }

  /** Indexed region query for hit-test/lasso/viewport/eraser broad phase. */
  queryRegion(bounds: Bounds): readonly SurfaceObjectId[] {
    this.ensureIndexes();
    return this.#spatialIndex.query(bounds);
  }

  /** Cached bounds for one id (O(1), for viewport/chrome layers). */
  cachedBoundsFor(id: SurfaceObjectId): Bounds | null {
    const record = this.#model.objects[id];
    if (record === undefined) return null;
    return this.#cachedBoundsOf(record);
  }

  /** Connectors bound to the moving selection (indexed, no full scan). */
  dragAffectedConnectors(): readonly SurfaceObjectId[] {
    const drag = this.#drag;
    if (drag === null || drag.kind !== 'move') return [];
    this.ensureIndexes();
    return this.#connectorIndex.connectorsFor(drag.movingIds);
  }

  /**
   * Lasso/tool ephemeral move API (shares the same session as pointer
   * drags): begin captures the current selection, update accumulates an
   * incremental delta (snapped), commit applies once, cancel discards.
   */
  beginEphemeralMove(startSurface?: Point): boolean {
    this.#assertAlive();
    if (this.#drag !== null) return false;
    this.ensureIndexes();
    const origins = this.#memberOrigins();
    if (origins.size === 0) return false;
    const movingIds = [...origins.keys()];
    this.#drag = {
      kind: 'move',
      startSurface:
        startSurface !== undefined ? { ...startSurface } : { ...this.#camera },
      origins,
      applied: { x: 0, y: 0 },
      startBounds: this.#unionBoundsFor(movingIds),
      movingIds,
    };
    return true;
  }

  updateEphemeralMove(delta: Point): void {
    this.#assertAlive();
    const drag = this.#drag;
    if (drag === null || drag.kind !== 'move') return;
    const targetX = drag.applied.x + delta.x;
    const targetY = drag.applied.y + delta.y;
    const snapped = this.#snapDeltaEphemeral(
      drag.movingIds,
      drag.startBounds,
      drag.origins,
      targetX,
      targetY,
    );
    drag.applied.x = snapped.x;
    drag.applied.y = snapped.y;
    this.#stats.ephemeralMoves += 1;
  }

  commitEphemeralMove(): readonly SurfaceObjectId[] {
    this.#assertAlive();
    const drag = this.#drag;
    if (drag === null || drag.kind !== 'move') return [];
    this.#drag = null;
    this.#clearSnapGuides();
    if (drag.applied.x === 0 && drag.applied.y === 0) return [];
    return this.#commitMoveDrag(drag);
  }

  cancelEphemeralMove(): void {
    this.#assertAlive();
    if (this.#drag === null || this.#drag.kind !== 'move') return;
    this.#drag = null;
    this.#clearSnapGuides();
  }

  // --- Selection ---

  setSelection(ids: readonly SurfaceObjectId[]): void {
    this.#assertAlive();
    // Member ids promote to their group; unknown ids pass through and
    // are filtered by consumers. Order follows first occurrence.
    const promoted: SurfaceObjectId[] = [];
    const seen = new Set<SurfaceObjectId>();
    for (const id of ids) {
      const group = groupOfMember(this.#model, id);
      const resolved = group ?? id;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      promoted.push(resolved);
    }
    this.#selection = promoted;
    this.#selectionBoundsCache = null;
  }

  /** Topmost object under a surface-space point; null on empty space. */
  hitTest(surfacePoint: Point): SurfaceObjectId | null {
    return this.#hitTestExcept(surfacePoint, null);
  }

  /** Contextual finger targets only; tolerance is in CSS pixels, never geometry. */
  touchSelectionTarget(
    viewPoint: Point,
  ):
    | { readonly kind: 'selection' }
    | { readonly kind: 'object'; readonly id: SurfaceObjectId }
    | null {
    const point = viewToSurface(this.#camera, viewPoint);
    const tolerance = 12 / Math.max(this.#camera.zoom, 1e-9);
    const expanded = (bounds: Bounds): Bounds => ({
      x: bounds.x - tolerance,
      y: bounds.y - tolerance,
      width: bounds.width + tolerance * 2,
      height: bounds.height + tolerance * 2,
    });
    if (this.#selection.length > 0) {
      const bounds = this.selectionBoundsCached();
      if (bounds !== null && pointInRotatedBounds(expanded(bounds), 0, point))
        return { kind: 'selection' };
    }
    const id = this.#hitTestExcept(point, null, tolerance);
    return id === null ? null : { kind: 'object', id };
  }

  #recordContains(record: SurfaceObjectRecord, p: Point): boolean {
    if (record.type === SURFACE_OBJECT_TYPES.stroke) record = inkInteractionRecord(this.#model, record);
    // Cheap exact pre-filter for Ink strokes: cached envelope bounds
    // already cover the rendered outline, so a query outside bounds⊕2
    // (hit tolerance) cannot hit — skip spine compilation entirely.
    // Other types hit-test cheaply already (bounds-first, no compiles).
    if (record.type === SURFACE_OBJECT_TYPES.stroke) {
      const cached = this.#cachedBoundsOf(record);
      if (cached === null) return false;
      const expanded: Bounds = {
        x: cached.x - INK_HIT_TOLERANCE,
        y: cached.y - INK_HIT_TOLERANCE,
        width: cached.width + INK_HIT_TOLERANCE * 2,
        height: cached.height + INK_HIT_TOLERANCE * 2,
      };
      if (!pointInRotatedBounds(expanded, rotationOf(record), p)) {
        return false;
      }
    }
    const descriptor = this.#registry.get(record.type);
    if (descriptor?.hitTest !== undefined) {
      try {
        return descriptor.hitTest(record, p.x, p.y);
      } catch {
        return false;
      }
    }
    // Fallback containment for types without a registered predicate.
    return pointInRotatedBounds(
      looseEnvelopeBounds(record),
      rotationOf(record),
      p,
    );
  }

  /**
   * True when an object is interaction-locked: its own flag, or
   * membership in a locked group. Locking a group
   * sets the flag on the group record only; members resolve through it
   * so lock/unlock stays one canonical write.
   */
  #isInteractionLocked(id: SurfaceObjectId): boolean {
    const record = this.#model.objects[id];
    if (record === undefined) return false;
    if (record.locked === true) return true;
    const groupId = groupOfMember(this.#model, id);
    if (groupId === null) return false;
    return this.#model.objects[groupId]?.locked === true;
  }

  /** Named anchor through the rotation-aware hook with envelope fallback. */
  #anchorOn(
    record: SurfaceObjectRecord,
    anchor: ConnectorAnchor,
  ): Point | null {
    const resolved = resolveConnectorAnchor(record, anchor, this.#registry);
    if (resolved !== null) return resolved;
    const bounds = this.#registry.get(record.type)?.boundsOf?.(record);
    if (bounds === undefined || bounds === null) return null;
    return anchorPoint(bounds, anchor);
  }

  // --- Pointer gestures ---

  pointerDown(
    event: NormalizedPointerEvent,
    preserveSelection = false,
  ): readonly SurfaceObjectId[] {
    this.#assertAlive();
    const surfacePoint = viewToSurface(this.#camera, event.point);
    if (preserveSelection && this.#selection.length > 0) {
      this.beginEphemeralMove(surfacePoint);
      return this.selection();
    }
    // Connector handles and quick-connect anchors win ties: they belong
    // to the current single selection and are smaller than bodies.
    const handle = this.#handleAt(surfacePoint);
    if (handle !== null) {
      if (handle.kind === 'endpoint') {
        const record = this.#model.objects[handle.id];
        const px = handle.end === 'source' ? 'x' : 'x2';
        const py = handle.end === 'source' ? 'y' : 'y2';
        const origX = finiteNumber(record?.[px]) ?? surfacePoint.x;
        const origY = finiteNumber(record?.[py]) ?? surfacePoint.y;
        this.#drag = {
          kind: 'endpoint',
          id: handle.id,
          end: handle.end,
          startSurface: surfacePoint,
          origBinding: record?.[handle.end],
          origX,
          origY,
        };
      } else {
        this.#drag = {
          kind: 'connect',
          fromId: handle.objectId,
          fromAnchor: handle.anchor,
          startView: { ...event.point },
          connectorId: null,
          moved: false,
        };
      }
      return this.selection();
    }
    const hit = this.hitTest(surfacePoint);

    if (hit === null) {
      this.#selection = [];
      this.#drag = null;
      return this.selection();
    }

    if (event.shift === true) {
      if (!this.#selection.includes(hit))
        this.#selection = [...this.#selection, hit];
    } else if (!this.#selection.includes(hit)) {
      this.#selection = [hit];
    }

    this.ensureIndexes();
    const origins = this.#memberOrigins();
    const movingIds = [...origins.keys()];
    const startBounds = this.#unionBoundsFor(movingIds);
    this.#drag = {
      kind: 'move',
      startSurface: surfacePoint,
      origins,
      applied: { x: 0, y: 0 },
      startBounds,
      movingIds,
    };
    return this.selection();
  }

  /**
   * Handle under a surface point for the single current selection:
   * connector endpoints first, then shape anchors. Null otherwise.
   */
  #handleAt(
    surfacePoint: Point,
  ):
    | { kind: 'endpoint'; id: SurfaceObjectId; end: 'source' | 'target' }
    | { kind: 'anchor'; objectId: SurfaceObjectId; anchor: ConnectorAnchor }
    | null {
    if (this.#selection.length !== 1) return null;
    const id = this.#selection[0]!;
    const record = this.#model.objects[id];
    if (record === undefined || this.#isInteractionLocked(id)) return null;
    const radius = HANDLE_GRAB_RADIUS_VIEW / Math.max(this.#camera.zoom, 1e-9);
    if (record.type === SURFACE_OBJECT_TYPES.line) {
      for (const end of ['source', 'target'] as const) {
        const x = finiteNumber(end === 'source' ? record.x : record.x2);
        const y = finiteNumber(end === 'source' ? record.y : record.y2);
        if (
          x !== null &&
          y !== null &&
          Math.hypot(surfacePoint.x - x, surfacePoint.y - y) <= radius
        ) {
          return { kind: 'endpoint', id, end };
        }
      }
      return null;
    }
    let best: { anchor: ConnectorAnchor; dist: number } | null = null;
    for (const handle of selectionHandles(
      this.#model,
      this.#registry,
      [id],
      this.#camera.zoom,
    )) {
      if (handle.kind !== 'anchor') continue;
      const dist = Math.hypot(
        surfacePoint.x - handle.x,
        surfacePoint.y - handle.y,
      );
      if (dist <= radius && (best === null || dist < best.dist))
        best = { anchor: handle.anchor, dist };
    }
    return best === null
      ? null
      : { kind: 'anchor', objectId: id, anchor: best.anchor };
  }

  /** Nearest envelope anchor to a drop point (for rebinding). */
  #nearestAnchor(
    record: SurfaceObjectRecord,
    bounds: Bounds,
    point: Point,
  ): ConnectorAnchor {
    let best: ConnectorAnchor = 'center';
    let bestDist = Infinity;
    for (const anchor of ['n', 's', 'e', 'w'] as const) {
      const candidate =
        this.#anchorOn(record, anchor) ?? anchorPoint(bounds, anchor);
      const dist = Math.hypot(point.x - candidate.x, point.y - candidate.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = anchor;
      }
    }
    return best;
  }

  /** Movable origins for the selection with groups expanded to members. */
  #memberOrigins(): Map<SurfaceObjectId, Point | null> {
    const origins = new Map<SurfaceObjectId, Point | null>();
    for (const id of resolveGroupMembers(this.#model, this.#selection)) {
      if (this.#isMovable(id)) origins.set(id, this.#movableOrigin(id));
    }
    return origins;
  }

  /** Translate the dragged selection; returns ids mutated this event. */
  pointerMove(event: NormalizedPointerEvent): readonly SurfaceObjectId[] {
    this.#assertAlive();
    const drag = this.#drag;
    if (drag === null) return [];
    const surfacePoint = viewToSurface(this.#camera, event.point);
    if (drag.kind === 'endpoint') {
      return this.#dragEndpoint(drag, surfacePoint);
    }
    if (drag.kind === 'connect') {
      return this.#dragConnect(drag, event.point, surfacePoint);
    }
    if (drag.origins.size === 0) return [];
    // Ephemeral drag (Slice 1): DO NOT mutate canonical, DO NOT bump
    // scene, DO NOT invalidate geometry. Only update delta + guides.
    const targetX = surfacePoint.x - drag.startSurface.x;
    const targetY = surfacePoint.y - drag.startSurface.y;
    const snapped = this.#snapDeltaEphemeral(
      drag.movingIds,
      drag.startBounds,
      drag.origins,
      targetX,
      targetY,
    );
    drag.applied.x = snapped.x;
    drag.applied.y = snapped.y;
    this.#stats.ephemeralMoves += 1;
    return [];
  }

  /** Follow the pointer with a free connector endpoint. */
  #dragEndpoint(
    drag: Extract<DragState, { kind: 'endpoint' }>,
    surfacePoint: Point,
  ): SurfaceObjectId[] {
    const record = this.#model.objects[drag.id];
    if (record === undefined) return [];
    const px = drag.end === 'source' ? 'x' : 'x2';
    const py = drag.end === 'source' ? 'y' : 'y2';
    if (record[px] === surfacePoint.x && record[py] === surfacePoint.y)
      return [];
    this.#before([drag.id]);
    delete (record as Record<string, unknown>)[drag.end];
    (record as Record<string, unknown>)[px] = surfacePoint.x;
    (record as Record<string, unknown>)[py] = surfacePoint.y;
    const mutated = [drag.id];
    for (const id of this.#reconcileViaIndex(mutated)) {
      if (!mutated.includes(id)) {
        this.#before([id]);
        mutated.push(id);
      }
    }
    this.#indexMutated(mutated);
    this.#onMutate?.(mutated);
    return mutated;
  }

  /**
   * Quick-connect drag: materialize a bound connector past the drag
   * threshold, then trail its free end at the pointer.
   */
  #dragConnect(
    drag: Extract<DragState, { kind: 'connect' }>,
    viewPoint: Point,
    surfacePoint: Point,
  ): SurfaceObjectId[] {
    if (
      !drag.moved &&
      Math.hypot(
        viewPoint.x - drag.startView.x,
        viewPoint.y - drag.startView.y,
      ) < CONNECT_DRAG_THRESHOLD_VIEW
    ) {
      return [];
    }
    drag.moved = true;
    if (drag.connectorId === null) {
      const from = this.#model.objects[drag.fromId];
      if (from === undefined) {
        this.#drag = null;
        return [];
      }
      const bounds = this.#registry.get(from.type)?.boundsOf?.(from);
      if (bounds === undefined || bounds === null) {
        this.#drag = null;
        return [];
      }
      const start =
        this.#anchorOn(from, drag.fromAnchor) ??
        anchorPoint(bounds, drag.fromAnchor);
      const id = this.#idFactory();
      this.#before([id]);
      this.#model.objects[id] = lineObject(id, {
        x: start.x,
        y: start.y,
        x2: surfacePoint.x,
        y2: surfacePoint.y,
        arrows: 'end',
        color: typeof from.color === 'string' ? from.color : '#37352f',
        width: 2,
        opacity: 1,
        source: { objectId: drag.fromId, anchor: drag.fromAnchor },
      });
      this.#model.order.push(id);
      drag.connectorId = id;
      this.#indexMutated([id]);
      this.#onMutate?.([id]);
      return [id];
    }
    const record = this.#model.objects[drag.connectorId];
    if (record === undefined) return [];
    this.#before([drag.connectorId]);
    (record as Record<string, unknown>).x2 = surfacePoint.x;
    (record as Record<string, unknown>).y2 = surfacePoint.y;
    this.#indexMutated([drag.connectorId]);
    this.#onMutate?.([drag.connectorId]);
    return [drag.connectorId];
  }

  pointerUp(event: NormalizedPointerEvent): void {
    this.#assertAlive();
    const drag = this.#drag;
    this.#drag = null;
    this.#clearSnapGuides();
    if (drag?.kind === 'endpoint') {
      this.#finishEndpointDrag(drag, viewToSurface(this.#camera, event.point));
    } else if (drag?.kind === 'connect') {
      this.#finishConnectDrag(drag, viewToSurface(this.#camera, event.point));
    } else if (drag?.kind === 'move') {
      // Ephemeral commit: one canonical transform, one history entry,
      // one scene invalidation. Zero-movement drags commit nothing.
      if (drag.applied.x !== 0 || drag.applied.y !== 0) {
        this.#commitMoveDrag(drag);
      }
    }
  }

  /** Abort a selection drag without committing further mutations. */
  pointerCancel(): void {
    this.#assertAlive();
    const drag = this.#drag;
    this.#drag = null;
    this.#clearSnapGuides();
    // Ephemeral move drags discard delta; canonical remains unchanged.
    if (drag?.kind === 'move') return;
    if (drag?.kind === 'endpoint') {
      // Restore pre-drag coords when they actually moved (provider
      // history also rolls back; this keeps the seam truthful alone).
      const record = this.#model.objects[drag.id];
      if (record !== undefined) {
        const px = drag.end === 'source' ? 'x' : 'x2';
        const py = drag.end === 'source' ? 'y' : 'y2';
        if (
          record[px] !== drag.origX ||
          record[py] !== drag.origY ||
          record[drag.end] !== drag.origBinding
        ) {
          this.#before([drag.id]);
          (record as Record<string, unknown>)[px] = drag.origX;
          (record as Record<string, unknown>)[py] = drag.origY;
          if (drag.origBinding === undefined)
            delete (record as Record<string, unknown>)[drag.end];
          else (record as Record<string, unknown>)[drag.end] = drag.origBinding;
          this.#indexMutated([drag.id]);
          this.#onMutate?.([drag.id]);
        }
      }
    } else if (drag?.kind === 'connect' && drag.connectorId !== null) {
      const id = drag.connectorId;
      if (this.#model.objects[id] !== undefined) {
        this.#before([id]);
        delete this.#model.objects[id];
        const index = this.#model.order.indexOf(id);
        if (index >= 0) this.#model.order.splice(index, 1);
        this.#onMutate?.([id]);
      }
    }
  }

  /**
   * Drop an endpoint drag: bind to the nearest anchor of the object
   * under the pointer (excluding the dragged connector), else keep the
   * free point. No-ops never mutate.
   */
  #finishEndpointDrag(
    drag: Extract<DragState, { kind: 'endpoint' }>,
    surfacePoint: Point,
  ): void {
    const record = this.#model.objects[drag.id];
    if (record === undefined) return;
    const px = drag.end === 'source' ? 'x' : 'x2';
    const py = drag.end === 'source' ? 'y' : 'y2';
    // Untouched endpoints (plain taps) never mutate or rebind.
    if (record[px] === drag.origX && record[py] === drag.origY) {
      if (drag.origBinding !== undefined)
        (record as Record<string, unknown>)[drag.end] = drag.origBinding;
      this.#indexMutated([drag.id]);
      return;
    }
    const hit = this.#hitTestExcept(surfacePoint, drag.id);
    if (hit !== null) {
      const target = this.#model.objects[hit];
      const bounds =
        target === undefined
          ? undefined
          : this.#registry.get(target.type)?.boundsOf?.(target);
      if (target !== undefined && bounds !== undefined && bounds !== null) {
        const anchor = this.#nearestAnchor(target, bounds, surfacePoint);
        const point =
          this.#anchorOn(target, anchor) ?? anchorPoint(bounds, anchor);
        this.#before([drag.id]);
        (record as Record<string, unknown>)[px] = point.x;
        (record as Record<string, unknown>)[py] = point.y;
        (record as Record<string, unknown>)[drag.end] = {
          objectId: hit,
          anchor,
        };
        this.#indexMutated([drag.id]);
        this.#onMutate?.([drag.id]);
        return;
      }
    }
    // Free drop:.coords already follow the pointer; skip no-op mutates.
    const x = finiteNumber(record[px]);
    const y = finiteNumber(record[py]);
    if (x === null || y === null || x !== drag.origX || y !== drag.origY) {
      this.#onMutate?.([drag.id]);
    }
  }

  /**
   * Drop a quick-connect drag: bind the trailing end to the object
   * under the pointer, or leave its endpoint free.
   * Taps (never materialized) do nothing.
   */
  #finishConnectDrag(
    drag: Extract<DragState, { kind: 'connect' }>,
    surfacePoint: Point,
  ): void {
    if (!drag.moved || drag.connectorId === null) return;
    const connector = this.#model.objects[drag.connectorId];
    if (connector === undefined) return;
    const hit = this.#hitTestExcept(surfacePoint, drag.connectorId);
    if (hit !== null && hit !== drag.fromId) {
      const target = this.#model.objects[hit];
      const bounds =
        target === undefined
          ? undefined
          : this.#registry.get(target.type)?.boundsOf?.(target);
      if (target !== undefined && bounds !== undefined && bounds !== null) {
        const anchor = this.#nearestAnchor(target, bounds, surfacePoint);
        const point =
          this.#anchorOn(target, anchor) ?? anchorPoint(bounds, anchor);
        this.#before([drag.connectorId]);
        (connector as Record<string, unknown>).x2 = point.x;
        (connector as Record<string, unknown>).y2 = point.y;
        (connector as Record<string, unknown>).target = {
          objectId: hit,
          anchor,
        };
        this.#indexMutated([drag.connectorId]);
        this.#onMutate?.([drag.connectorId]);
        return;
      }
    }
    // Empty drops keep a free endpoint; creating a connection never inserts content.
  }

  /** Topmost object id excluding one record (dragged connectors). */
  #hitTestExcept(
    surfacePoint: Point,
    excludeId: SurfaceObjectId | null,
    touchTolerance?: number,
  ): SurfaceObjectId | null {
    const contains = (record: SurfaceObjectRecord): boolean => {
      if (touchTolerance === undefined)
        return this.#recordContains(record, surfacePoint);
      if (record.type !== SURFACE_OBJECT_TYPES.text)
        return this.#recordContains(record, surfacePoint);
      const bounds = this.#cachedBoundsOf(record);
      return (
        bounds !== null &&
        pointInRotatedBounds(
          {
            x: bounds.x - touchTolerance,
            y: bounds.y - touchTolerance,
            width: bounds.width + touchTolerance * 2,
            height: bounds.height + touchTolerance * 2,
          },
          rotationOf(record),
          surfacePoint,
        )
      );
    };
    // Indexed candidate discovery (Slice 4): query the spatial index with
    // a box covering every indexed record's hit reach, test candidates
    // topmost-first, then scan only ids missing from the index (unbounded
    // custom types). Never compiles or distance-tests the whole document.
    if (this.#indexesBuilt) {
      const pad = Math.max(this.#maxHitPad, touchTolerance ?? 0, 1);
      const candidates = this.#spatialIndex.query({
        x: surfacePoint.x - pad,
        y: surfacePoint.y - pad,
        width: pad * 2,
        height: pad * 2,
      });
      if (candidates.length > 0) {
        const rank = new Map(
          this.#model.order.map((id, i) => [id, i] as const),
        );
        const sorted = [...candidates].sort(
          (a, b) => (rank.get(b) ?? -1) - (rank.get(a) ?? -1),
        );
        for (const id of sorted) {
          if (id === excludeId) continue;
          const record = this.#model.objects[id];
          if (record === undefined) continue;
          if (record.type === SURFACE_OBJECT_TYPES.group) continue;
          if (this.#isInteractionLocked(id)) continue;
          if (contains(record)) {
            return groupOfMember(this.#model, id) ?? id;
          }
        }
      }
      // Fallback for records the index cannot cover (null bounds): scan
      // only those, never the indexed majority.
      const { objects } = this.#model;
      for (let i = this.#model.order.length - 1; i >= 0; i--) {
        const id = this.#model.order[i]!;
        if (id === excludeId) continue;
        if (this.#spatialIndex.has(id)) continue;
        const record = objects[id];
        if (record === undefined) continue;
        if (record.type === SURFACE_OBJECT_TYPES.group) continue;
        if (this.#isInteractionLocked(id)) continue;
        if (contains(record)) {
          return groupOfMember(this.#model, id) ?? id;
        }
      }
      return null;
    }
    this.#spatialIndex.noteFullScan();
    const { objects } = this.#model;
    for (let i = this.#model.order.length - 1; i >= 0; i--) {
      const id = this.#model.order[i]!;
      if (id === excludeId) continue;
      const record = objects[id];
      if (record === undefined) continue;
      // Groups are organizational: members hit-test, then promote.
      if (record.type === SURFACE_OBJECT_TYPES.group) continue;
      // Locked groups shelter their members exactly like own flags:
      // scanning continues underneath instead of selecting through.
      if (this.#isInteractionLocked(id)) continue;
      if (contains(record)) {
        return groupOfMember(this.#model, id) ?? id;
      }
    }
    return null;
  }

  // --- Direct mutations ---

  /** Translate the whole selection by a surface-space delta. */
  moveSelectionBy(delta: Point): readonly SurfaceObjectId[] {
    this.#assertAlive();
    return this.#applyTranslation(delta.x, delta.y, this.#memberOrigins()).ids;
  }

  /** Whether every non-organizational record can participate in a page rebase. */
  canTranslateAll(): boolean {
    this.#assertAlive();
    for (const id of this.#model.order) {
      const record = this.#model.objects[id];
      if (record === undefined || record.type === SURFACE_OBJECT_TYPES.group)
        continue;
      if (
        this.#registry.get(record.type)?.translate === undefined &&
        this.#movableOrigin(id) === null
      )
        return false;
    }
    return true;
  }

  /**
   * Rigidly rebase every concrete record exactly once. Groups carry no
   * geometry, and connectors move with their endpoints, so reconciliation
   * is intentionally unnecessary when the complete scene shares a delta.
   */
  translateAllBy(delta: Point): readonly SurfaceObjectId[] {
    this.#assertAlive();
    if ((delta.x === 0 && delta.y === 0) || !this.canTranslateAll()) return [];
    const ids = this.#model.order.filter((id) => {
      const record = this.#model.objects[id];
      return record !== undefined && record.type !== SURFACE_OBJECT_TYPES.group;
    });
    if (ids.length === 0) return [];
    this.#onBeforeTranslate?.(ids, delta.x, delta.y);
    if (this.#onBeforeTranslate === null) this.#before(ids);
    const mutated: SurfaceObjectId[] = [];
    for (const id of ids) {
      const record = this.#model.objects[id];
      if (record === undefined) continue;
      const translate = this.#registry.get(record.type)?.translate;
      if (translate !== undefined) {
        translate(record, delta.x, delta.y);
      } else {
        const origin = this.#movableOrigin(id);
        if (origin === null) continue;
        (record as Record<string, unknown>).x = origin.x + delta.x;
        (record as Record<string, unknown>).y = origin.y + delta.y;
      }
      mutated.push(id);
    }
    if (mutated.length > 0) {
      this.#indexTranslated(mutated, delta.x, delta.y);
      this.#onMutate?.(mutated);
    }
    return mutated;
  }

  resizeObject(
    id: SurfaceObjectId,
    size: { readonly width?: number; readonly height?: number },
  ): void {
    this.#assertAlive();
    const record = this.#requireRecord(id);
    for (const key of ['width', 'height'] as const) {
      const requested = size[key];
      if (requested === undefined) continue;
      if (!Number.isFinite(requested)) {
        throw new FroglightError(
          ErrorCodes.FORMAT_LIMIT_EXCEEDED,
          `${key} must be finite`,
        );
      }
      if (Math.abs(requested) > SURFACE_MAX_COORDINATE) {
        throw new FroglightError(
          ErrorCodes.FORMAT_LIMIT_EXCEEDED,
          `${key} exceeds the coordinate cap`,
        );
      }
    }
    // Type-owned geometric resize first (strokes scale samples); the
    // envelope fallback below only fits stored-box types.
    const resize = this.#registry.get(record.type)?.resize;
    if (resize !== undefined) {
      let handled = false;
      try {
        this.#before([id]);
        handled = resize(record, size);
      } catch {
        handled = false;
      }
      if (handled) {
        const followed = this.#reconcileViaIndex([id]).filter(
          (other) => other !== id,
        );
        const all = [id, ...followed];
        this.#indexMutated(all);
        this.#onMutate?.(all);
        return;
      }
    }
    const mutated: SurfaceObjectId[] = [];
    for (const key of ['width', 'height'] as const) {
      const requested = size[key];
      if (requested === undefined) continue;
      // Only sized envelopes carry a stored box (spec §5): `text` has none.
      if (typeof record[key] !== 'number') continue;
      if (!mutated.includes(id)) this.#before([id]);
      (record as Record<string, unknown>)[key] = Math.max(requested, 0);
      mutated.push(id);
    }
    if (mutated.length === 0) return;
    // Single-object API: one mutation event regardless of axis count.
    // Reconciliation is canonical work: it runs with or without a listener.
    const followedResize = this.#reconcileViaIndex([id]).filter(
      (other) => other !== id,
    );
    const allResize = [id, ...followedResize];
    this.#indexMutated(allResize);
    this.#onMutate?.(allResize);
  }

  rotateObject(id: SurfaceObjectId, deltaRadians: number): void {
    this.#assertAlive();
    const record = this.#requireRecord(id);
    if (!Number.isFinite(deltaRadians)) {
      throw new FroglightError(
        ErrorCodes.FORMAT_LIMIT_EXCEEDED,
        'rotation delta must be finite',
      );
    }
    const current = finiteNumber(record.rotation) ?? 0;
    const next = current + deltaRadians;
    if (!Number.isFinite(next) || Math.abs(next) > SURFACE_MAX_COORDINATE) {
      throw new FroglightError(
        ErrorCodes.FORMAT_LIMIT_EXCEEDED,
        'rotation exceeds the coordinate cap',
      );
    }
    this.#before([id]);
    (record as Record<string, unknown>).rotation = next;
    const followed = this.#reconcileViaIndex([id]).filter(
      (other) => other !== id,
    );
    const allRot = [id, ...followed];
    this.#indexMutated(allRot);
    this.#onMutate?.(allRot);
  }

  // --- Selection arrangement (slice 9) ---

  /**
   * Align selected members to the selection union edge/center. Locked,
   * unmovable, and boundless records are skipped. One mutation event.
   */
  alignSelection(edge: AlignEdge): SurfaceObjectId[] {
    this.#assertAlive();
    const targets = this.#arrangeableMembers();
    if (targets.length < 2) return [];
    let line = 0;
    if (edge === 'left' || edge === 'top') {
      line = Math.min(
        ...targets.map((t) => (edge === 'left' ? t.bounds.x : t.bounds.y)),
      );
    } else if (edge === 'right' || edge === 'bottom') {
      line = Math.max(
        ...targets.map((t) =>
          edge === 'right'
            ? t.bounds.x + t.bounds.width
            : t.bounds.y + t.bounds.height,
        ),
      );
    } else {
      const vertical = edge === 'centerY';
      line =
        targets.reduce(
          (sum, t) =>
            sum +
            (vertical
              ? t.bounds.y + t.bounds.height / 2
              : t.bounds.x + t.bounds.width / 2),
          0,
        ) / targets.length;
    }
    const moved: SurfaceObjectId[] = [];
    for (const t of targets) {
      const current =
        edge === 'left'
          ? t.bounds.x
          : edge === 'right'
            ? t.bounds.x + t.bounds.width
            : edge === 'top'
              ? t.bounds.y
              : edge === 'bottom'
                ? t.bounds.y + t.bounds.height
                : edge === 'centerY'
                  ? t.bounds.y + t.bounds.height / 2
                  : t.bounds.x + t.bounds.width / 2;
      const delta = line - current;
      if (delta === 0) continue;
      const horizontal =
        edge === 'left' || edge === 'right' || edge === 'centerX';
      if (
        this.#translateBy(t.id, horizontal ? delta : 0, horizontal ? 0 : delta)
      ) {
        moved.push(t.id);
      }
    }
    if (moved.length === 0) return moved;
    const followed = this.#reconcileViaIndex(moved).filter(
      (id) => !moved.includes(id),
    );
    const allAlign = [...moved, ...followed];
    this.#indexMutated(allAlign);
    this.#onMutate?.(allAlign);
    return moved;
  }

  /**
   * Distribute three or more selected members with equal gaps along an
   * axis, keeping the outer pair fixed. Locked, unmovable, and boundless
   * records are excluded. One mutation event.
   */
  distributeSelection(axis: DistributeAxis): SurfaceObjectId[] {
    this.#assertAlive();
    const horizontal = axis === 'x';
    const targets = this.#arrangeableMembers()
      .map((t) => ({
        id: t.id,
        min: horizontal ? t.bounds.x : t.bounds.y,
        size: horizontal ? t.bounds.width : t.bounds.height,
      }))
      .sort((a, b) => a.min - b.min);
    if (targets.length < 3) return [];
    const first = targets[0]!;
    const last = targets[targets.length - 1]!;
    const span = last.min + last.size - first.min;
    const used = targets.reduce((sum, t) => sum + t.size, 0);
    const gap = (span - used) / (targets.length - 1);
    const moved: SurfaceObjectId[] = [];
    let cursor = first.min + first.size + gap;
    for (let i = 1; i < targets.length - 1; i++) {
      const t = targets[i]!;
      const delta = cursor - t.min;
      if (
        delta !== 0 &&
        this.#translateBy(t.id, horizontal ? delta : 0, horizontal ? 0 : delta)
      ) {
        moved.push(t.id);
      }
      cursor += t.size + gap;
    }
    if (moved.length === 0) return moved;
    const followedDistribute = this.#reconcileViaIndex(moved).filter(
      (id) => !moved.includes(id),
    );
    const allDist = [...moved, ...followedDistribute];
    this.#indexMutated(allDist);
    this.#onMutate?.(allDist);
    return moved;
  }

  /**
   * Set or clear the `locked` flag on objects. Locked objects skip
   * hit-testing and selection while remaining visible. One mutation.
   */
  setLocked(
    ids: readonly SurfaceObjectId[],
    locked: boolean,
  ): SurfaceObjectId[] {
    this.#assertAlive();
    if (typeof locked !== 'boolean') {
      throw new FroglightError(
        ErrorCodes.RECORD_FORMAT_MISMATCH,
        'locked must be a boolean',
      );
    }
    const mutated: SurfaceObjectId[] = [];
    // History contract: before-images for the whole batch precede ANY
    // canonical mutation (idempotent per gesture).
    if (ids.length > 0) this.#before([...ids]);
    for (const id of ids) {
      const record = this.#model.objects[id];
      if (record === undefined) continue;
      if ((record.locked === true) === locked) continue;
      if (locked) {
        (record as Record<string, unknown>).locked = true;
      } else {
        delete (record as Record<string, unknown>).locked;
      }
      mutated.push(id);
    }
    if (mutated.length > 0) this.#onMutate?.(mutated);
    return mutated;
  }

  /**
   * Movable, unlocked members of the selection with usable bounds —
   * the working set for arrangement verbs. Groups expand to members;
   * members of locked groups are skipped like own-locked records.
   */
  #arrangeableMembers(): Array<{ id: SurfaceObjectId; bounds: Bounds }> {
    const out: Array<{ id: SurfaceObjectId; bounds: Bounds }> = [];
    for (const id of resolveGroupMembers(this.#model, this.#selection)) {
      const record = this.#model.objects[id];
      if (record === undefined || record.locked === true) continue;
      if (this.#isInteractionLocked(id)) continue;
      if (!this.#isMovable(id)) continue;
      const bounds = this.#registry.get(record.type)?.boundsOf?.(record);
      if (bounds === undefined || bounds === null) continue;
      out.push({ id, bounds });
    }
    return out;
  }

  /** Incremental translate of one record; false when not translatable. */
  #translateBy(id: SurfaceObjectId, dx: number, dy: number): boolean {
    const record = this.#model.objects[id];
    if (record === undefined) return false;
    const translate = this.#registry.get(record.type)?.translate;
    if (translate !== undefined) {
      try {
        this.#before([id]);
        translate(record, dx, dy);
      } catch {
        return false;
      }
      return true;
    }
    const origin = this.#movableOrigin(id);
    if (origin === null) return false;
    this.#before([id]);
    (record as Record<string, unknown>).x = origin.x + dx;
    (record as Record<string, unknown>).y = origin.y + dy;
    return true;
  }

  // --- Camera gestures ---

  wheel(event: NormalizedWheelEvent): Camera {
    this.#assertAlive();
    const raw =
      event.factor !== undefined
        ? event.factor
        : Math.pow(this.#wheelZoomBase, -(event.deltaY ?? 0) / 100);
    let factor = raw;
    const projected = this.#camera.zoom * factor;
    if (this.#minZoom !== null && projected < this.#minZoom) {
      factor = this.#minZoom / this.#camera.zoom;
    } else if (this.#maxZoom !== null && projected > this.#maxZoom) {
      factor = this.#maxZoom / this.#camera.zoom;
    }
    this.#camera = zoomCameraAt(this.#camera, event.point, factor);
    return this.camera();
  }

  /** Pan by a view-space delta (converted through the current zoom). */
  panBy(deltaView: Point): void {
    this.#assertAlive();
    this.#camera = {
      ...this.#camera,
      x: this.#camera.x + deltaView.x / this.#camera.zoom,
      y: this.#camera.y + deltaView.y / this.#camera.zoom,
    };
  }

  zoomAtView(viewPoint: Point, factor: number): void {
    this.wheel({ point: viewPoint, factor });
  }

  // --- Lifecycle ---

  destroy(): void {
    this.#destroyed = true;
    this.#drag = null;
    this.#selection = [];
  }

  // --- Internals ---

  #assertAlive(): void {
    if (this.#destroyed) {
      throw new FroglightError(
        ErrorCodes.SERVICE_DISPOSED,
        'the surface interaction controller has been destroyed',
      );
    }
  }

  #requireRecord(id: SurfaceObjectId): SurfaceObjectRecord {
    const record = this.#model.objects[id];
    if (record === undefined) {
      throw new FroglightError(
        ErrorCodes.INVALID_ID,
        `unknown surface object: ${id}`,
      );
    }
    return record;
  }

  #isMovable(id: SurfaceObjectId): boolean {
    const record = this.#model.objects[id];
    if (record === undefined) return false;
    // Locked objects skip hit-testing and selection transforms alike;
    // members shelter under a locked group the same way.
    if (record.locked === true || this.#isInteractionLocked(id)) return false;
    if (this.#registry.get(record.type)?.translate !== undefined) return true;
    return finiteNumber(record.x) !== null && finiteNumber(record.y) !== null;
  }

  #movableOrigin(id: SurfaceObjectId): Point | null {
    const record = this.#model.objects[id];
    if (record === undefined) return null;
    const x = finiteNumber(record.x);
    const y = finiteNumber(record.y);
    return x === null || y === null ? null : { x, y };
  }

  #applyTranslation(
    dx: number,
    dy: number,
    origins: ReadonlyMap<SurfaceObjectId, Point | null>,
  ): {
    readonly ids: readonly SurfaceObjectId[];
    readonly dx: number;
    readonly dy: number;
  } {
    // Immediate verb path (moveSelectionBy, programmatic): snap via the
    // spatial index (no full-model scan), then apply once with a single
    // history hook (command when available, patch fallback).
    let tdx = dx;
    let tdy = dy;
    if (this.#snapThresholdView > 0) {
      const snapped = this.#snapDeltaIndexed(origins, dx, dy);
      tdx = dx + snapped.dx;
      tdy = dy + snapped.dy;
    }
    const ids = [...origins.keys()];
    if (ids.length === 0) return { ids: [], dx: 0, dy: 0 };
    // Command seam first so pure translations avoid sample-array clones.
    if (this.#onBeforeTranslate !== null && (tdx !== 0 || tdy !== 0)) {
      this.#onBeforeTranslate(ids, tdx, tdy);
    } else {
      this.#before(ids);
    }
    const mutated: SurfaceObjectId[] = [];
    const clock = controllerClock();
    const canonicalStart = clock();
    for (const [id, origin] of origins) {
      const record = this.#model.objects[id];
      if (record === undefined) continue;
      const translate = this.#registry.get(record.type)?.translate;
      if (translate !== undefined) {
        try {
          translate(record, tdx, tdy);
          this.#stats.canonicalSamplesTranslated += countSamplesOf(record);
        } catch {
          continue;
        }
      } else if (origin !== null) {
        const current = this.#movableOrigin(id) ?? origin;
        (record as Record<string, unknown>).x = current.x + tdx;
        (record as Record<string, unknown>).y = current.y + tdy;
      } else {
        continue;
      }
      mutated.push(id);
    }
    this.#stats.canonicalTranslateMs += clock() - canonicalStart;
    if (mutated.length === 0) return { ids: mutated, dx: 0, dy: 0 };
    const followers = this.#reconcileViaIndex(mutated).filter(
      (id) => !mutated.includes(id),
    );
    for (const id of followers) {
      // Followers are geometry mutations (new anchor positions), not rigid
      // translations — patch history already covers primaries via command.
      this.#before([id]);
      mutated.push(id);
    }
    // Geometry-preserving translation for primaries (no rescans/recompiles);
    // full invalidation only for reconciled followers (lines, cheap).
    const primaries = mutated.slice(0, mutated.length - followers.length);
    const derivedStart = clock();
    if (primaries.length > 0) this.#indexTranslated(primaries, tdx, tdy);
    if (followers.length > 0) this.#indexMutated(followers);
    this.#stats.derivedTranslateMs += clock() - derivedStart;
    this.#onMutate?.(mutated);
    return { ids: mutated, dx: tdx, dy: tdy };
  }

  /**
   * Ephemeral snap (Slice 4): moving bounds derive from the drag-start
   * union translated by the total delta (no per-move sample scans);
   * statics come from the spatial index query (no `model.order` scan).
   */
  #snapDeltaEphemeral(
    movingIds: readonly SurfaceObjectId[],
    startBounds: Bounds | null,
    origins: ReadonlyMap<SurfaceObjectId, Point | null>,
    dx: number,
    dy: number,
  ): { x: number; y: number } {
    if (this.#snapThresholdView <= 0 || startBounds === null) {
      if (this.#snapThresholdView <= 0) return { x: dx, y: dy };
    }
    if (movingIds.length === 0 || startBounds === null) {
      this.#onSnapGuides?.([]);
      return { x: dx, y: dy };
    }
    const moving: Bounds = {
      x: startBounds.x + dx,
      y: startBounds.y + dy,
      width: startBounds.width,
      height: startBounds.height,
    };
    const threshold =
      this.#snapThresholdView / Math.max(this.#camera.zoom, 1e-9);
    this.ensureIndexes();
    const queryBounds = expandBounds(moving, threshold + 1);
    const nearby = this.#spatialIndex.query(queryBounds);
    const movingSet = new Set(movingIds);
    const statics: Bounds[] = [];
    for (const id of nearby) {
      if (movingSet.has(id)) continue;
      const cached = this.#spatialIndex.getBounds(id);
      if (cached !== null) statics.push(cached);
    }
    this.#stats.snapCandidatesScanned += statics.length;
    // Fallback when origins contain ids missing from the index (e.g.,
    // external bulk loads without rebuild): use cached bounds directly.
    void origins;
    const snap = computeSnap(moving, statics, threshold);
    const guides = snap.guides.map((guide) => guideDrawItem(guide));
    this.#guidesOut = guides.length > 0;
    this.#onSnapGuides?.(guides);
    return { x: dx + snap.dx, y: dy + snap.dy };
  }

  /**
   * Indexed snap for immediate verbs (same candidate discipline as the
   * ephemeral path, but from live origins + delta).
   */
  #snapDeltaIndexed(
    origins: ReadonlyMap<SurfaceObjectId, Point | null>,
    dx: number,
    dy: number,
  ): { dx: number; dy: number } {
    const movingIds = [...origins.keys()];
    const startBounds = this.#unionBoundsFor(movingIds);
    if (startBounds === null) {
      this.#onSnapGuides?.([]);
      return { dx: 0, dy: 0 };
    }
    const snapped = this.#snapDeltaEphemeral(
      movingIds,
      startBounds,
      origins,
      dx,
      dy,
    );
    return { dx: snapped.x - dx, dy: snapped.y - dy };
  }

  /** Union bounds for ids via the derived cache (computed once per drag). */
  #unionBoundsFor(ids: readonly SurfaceObjectId[]): Bounds | null {
    return selectionBoundsFor(
      this.#model,
      this.#registry,
      ids,
      (record) => this.#cachedBoundsOf(record),
    );
  }

  /**
   * One canonical transform commit for an ephemeral drag (Slice 1):
   * history hook once, sample mutation once, connector reconcile once,
   * scene invalidation once.
   */
  #commitMoveDrag(
    drag: Extract<DragState, { kind: 'move' }>,
  ): readonly SurfaceObjectId[] {
    const dx = drag.applied.x;
    const dy = drag.applied.y;
    if (dx === 0 && dy === 0) return [];
    const ids = [...drag.movingIds];
    if (this.#onBeforeTranslate !== null) {
      this.#onBeforeTranslate(ids, dx, dy);
    } else {
      this.#before(ids);
    }
    const clock = controllerClock();
    const canonicalStart = clock();
    const mutated: SurfaceObjectId[] = [];
    for (const [id, origin] of drag.origins) {
      const record = this.#model.objects[id];
      if (record === undefined) continue;
      const translate = this.#registry.get(record.type)?.translate;
      if (translate !== undefined) {
        try {
          translate(record, dx, dy);
          this.#stats.canonicalSamplesTranslated += countSamplesOf(record);
        } catch {
          continue;
        }
      } else if (origin !== null) {
        const current = this.#movableOrigin(id) ?? origin;
        (record as Record<string, unknown>).x = current.x + dx;
        (record as Record<string, unknown>).y = current.y + dy;
      } else {
        continue;
      }
      mutated.push(id);
    }
    // Canonical point rewrite cost, isolated from derived work below.
    this.#stats.canonicalTranslateMs += clock() - canonicalStart;
    if (mutated.length === 0) return mutated;
    const followers = this.#reconcileViaIndex(mutated).filter(
      (id) => !mutated.includes(id),
    );
    for (const id of followers) {
      if (!mutated.includes(id)) {
        // Followers mutated inside reconcile; command history already
        // covers primaries, patch covers followers via onBeforeMutate.
        this.#before([id]);
        mutated.push(id);
      }
    }
    // Geometry-preserving commit (item 1): primaries shift derived caches
    // without rescans or B-spline recompiles; followers (bound connectors)
    // take the normal geometry-mutation path.
    const primaries =
      followers.length === 0
        ? mutated
        : mutated.filter((id) => !followers.includes(id));
    const derivedStart = clock();
    if (primaries.length > 0) this.#indexTranslated(primaries, dx, dy);
    if (followers.length > 0) this.#indexMutated(followers);
    this.#stats.derivedTranslateMs += clock() - derivedStart;
    this.#stats.dragCommits += 1;
    this.#onMutate?.(mutated);
    return mutated;
  }

  /**
   * Indexed connector reconciliation (Slice 5): only connectors bound to
   * `movedIds` via the reverse index, never a full model scan.
   */
  #reconcileViaIndex(movedIds: readonly SurfaceObjectId[]): SurfaceObjectId[] {
    if (movedIds.length === 0) return [];
    this.ensureIndexes();
    const candidates = this.#connectorIndex.connectorsFor(movedIds);
    this.#stats.connectorRecordsScanned += candidates.length;
    if (candidates.length === 0) return [];
    const moved = new Set(movedIds);
    const reconciled: SurfaceObjectId[] = [];
    for (const id of candidates) {
      const record = this.#model.objects[id];
      if (record === undefined) continue;
      let changed = false;
      for (const key of ['source', 'target'] as const) {
        const raw = (record as Record<string, unknown>)[key];
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          continue;
        }
        const binding = raw as Record<string, unknown>;
        const objectId = binding.objectId;
        const anchor = binding.anchor;
        if (typeof objectId !== 'string' || !moved.has(objectId)) continue;
        if (
          anchor !== 'center' &&
          anchor !== 'n' &&
          anchor !== 's' &&
          anchor !== 'e' &&
          anchor !== 'w'
        ) {
          continue;
        }
        const target = this.#model.objects[objectId];
        if (target === undefined) continue;
        const point = resolveConnectorAnchor(
          target,
          anchor as ConnectorAnchor,
          this.#registry,
        );
        if (point === null) continue;
        const px = key === 'source' ? 'x' : 'x2';
        const py = key === 'source' ? 'y' : 'y2';
        if (record[px] !== point.x || record[py] !== point.y) {
          // Connector followers are canonical mutations: capture the
          // before-image BEFORE rewriting (history patch contract). The
          // recorder is idempotent per gesture, so primaries already
          // recorded are unaffected.
          if (!changed) this.#before([id]);
          (record as Record<string, unknown>)[px] = point.x;
          (record as Record<string, unknown>)[py] = point.y;
          changed = true;
        }
      }
      if (changed) {
        reconciled.push(id);
        // Keep the reverse index fresh (bindings unchanged here, but the
        // connector record itself moved → refresh spatial entry).
        this.#indexInsert(id);
      }
    }
    return reconciled;
  }

  /** Clear stale guides at gesture boundaries (only if any are out). */
  #clearSnapGuides(): void {
    if (!this.#guidesOut) return;
    this.#guidesOut = false;
    this.#onSnapGuides?.([]);
  }
}

/** Canonical Ink samples carried by a record (0 for non-stroke). */
function countSamplesOf(record: { type?: unknown; points?: unknown }): number {
  if (record.type !== 'froglight.ink.stroke') return 0;
  const points = (record as { points?: unknown }).points;
  return Array.isArray(points) ? points.length : 0;
}

/** Monotonic clock for commit- (never a CI gate).*/
function controllerClock(): () => number {
  try {
    const perf = (globalThis as unknown as { performance?: { now(): number } })
      .performance;
    if (perf !== undefined && typeof perf.now === 'function') {
      return () => perf.now();
    }
  } catch {
    // Fall through to Date.now.
  }
  return () => Date.now();
}

/**
 * Conservative hit-test reach for one record in surface units: the
 * per-type hit threshold beyond cached envelope bounds. The spatial
 * hit-test query uses the document max of this value, so candidates
 * always cover every hittable record (exact, never drops hits).
 */
function hitPadFor(record: SurfaceObjectRecord): number {
  if (record.type === SURFACE_OBJECT_TYPES.stroke) {
    return maxStrokeHalfWidth(record) + INK_HIT_TOLERANCE;
  }
  if (record.type === SURFACE_OBJECT_TYPES.line) {
    const width = finiteNumber(record.width);
    const lineWidth = width !== null && width > 0 ? width : INK_DEFAULT_WIDTH;
    return lineWidth / 2 + INK_HIT_TOLERANCE;
  }
  return 0;
}

/** One guide segment as a plain-data line draw item (ephemeral). */
function guideDrawItem(guide: SnapGuide): DrawItem {
  const vertical = guide.axis === 'x';
  const x1 = vertical ? guide.position : guide.from;
  const y1 = vertical ? guide.from : guide.position;
  const x2 = vertical ? guide.position : guide.to;
  const y2 = vertical ? guide.to : guide.position;
  return {
    kind: 'line',
    objectId: vertical ? 'snap-guide-x' : 'snap-guide-y',
    bounds: {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    },
    rotation: 0,
    x: x1,
    y: y1,
    x2,
    y2,
    width: 1.5,
    color: SNAP_GUIDE_COLOR,
  };
}
