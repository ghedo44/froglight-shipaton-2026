/**
 * Committed scene renderer.
 *
 * Owns the full committed render pipeline behind a focused internal
 * collaborator so `surface.ts` stays a facade that composes collaborators,
 * owns the public `InkSurfaceHandle`, and coordinates controller/history/
 * pointer/text/image collaborators.
 *
 * Owned here:
 * - backing/cache canvas lifecycle (engine-owned offscreen cache)
 * - viewport/DPR synchronization required by rendering
 * - renderer backend construction (view + cache, image-resolver consumption)
 * - scene cache invalidation/rebuild (paper, dot-grid, surface scene, outline)
 * - background rendering (template/background items + dot-grid)
 * - image resolver/cache consumption during rendering
 * - cached-scene → visible-canvas compositing (clear, drawImage, overlays)
 * - overlay composition sequencing (previews, selection chrome, resize
 *   handles, object handle)
 *
 * Not owned here:
 * - scene versioning / invalidation scheduling (facade via render scheduler)
 * - camera ownership / input mapping (controller + camera math)
 * - pointer/text/image/history state (dedicated collaborators)
 *
 * The renderer never mutates canonical `SurfaceModel`: it reads the model
 * through `renderSurfaceScene` and pure geometry helpers only.
 */

import {
  createDefaultSurfaceObjectTypeRegistry,
  selectionHandles,
  defaultPaperSpacingForTemplate,
  dispatchScene,
  frameBounds,
  IncrementalSceneCache,
  FIRST_PAINT_MAX_COST,
  estimatePrepareCost,
  preparedItems,
  preparedAabb,
  viewportSurfaceRect,
  ColdInkCompileScheduler,
  orderByPreparationPriority,
  logicalIdOf,
  type Bounds,
  type SurfaceObjectTypeRegistry,
  type Camera,
  type ColdSchedulerStats,
  type CompiledRestoreSource,
  type DrawItem,
  type IncrementalSceneStats,
  type PreparedItem,
  type Point,
  type SurfaceModel,
} from '@froglight/foundation';
import {
  CanvasSurfaceRendererBackend,
  type SurfaceImageResolver,
} from '@froglight/surface-default';
import {
  computePageViewRect,
  paintObjectResizeHandle,
  paintResizeHandles,
  paintSelectionChrome,
} from './render-scene.js';
import { surfacePaper } from '../paper.js';
import { buildRenderCacheKey } from './render-loop.js';
import { createInkCompileWorker } from './background-pack-worker.js';

export type CommittedPresentation =
  | 'paint-stage'
  | 'embedded-paper'
  | 'embedded-overlay';

export interface CommittedRendererPorts {
  readonly objectRegistry?: SurfaceObjectTypeRegistry;
  readonly model: SurfaceModel;
  readonly presentation: CommittedPresentation;
  readonly page: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly root: HTMLElement;
  readonly backgroundItems?: () => readonly DrawItem[];
  /** Clip rasterization to this host viewport; fit/input still use the full page. */
  readonly renderViewport?: HTMLElement;
  readonly imageResolver?: SurfaceImageResolver;
  /** Provider image cache; `requestSurface` is invoked on cache rebuild. */
  readonly imageCache?: {
    requestSurface(model: SurfaceModel): void;
  } | null;
  readonly frameResizable: boolean;
  /** Live authoring state; read-only surfaces omit resize affordances. */
  readonly isReadOnly?: () => boolean;
  /**
   * Lazy packed-cache restore source (dense-document reopen): consulted
   * by the incremental scene cache exactly when an object enters
   * viewport/progressive preparation priority. Absent means normal
   * compilation only.
   */
  readonly compiledRestore?: CompiledRestoreSource | null;
  /**
   * Indexed viewport query for lazy open (Slice 7/9): ids whose cached
   * bounds intersect the given surface bounds. When absent, the renderer
   * falls back to full-scene rebuilds (legacy test path).
   */
  readonly queryVisible?: (bounds: Bounds) => readonly string[];
  /**
   * Request a render frame (progressive fill repaints). Wired to the
   * facade's coalescing scheduler; absent in unit tests (deterministic).
   */
  readonly scheduleRender?: () => void;
  /**
   * Reports mutation ids after the committed scene has prepared them.
   * Consumers may now rely on rich compiled geometry being truthful.
   */
  readonly onContentPrepared?: (ids: readonly string[]) => void;
}

export interface SelectionDragRenderState {
  readonly ids: readonly string[];
  readonly dx: number;
  readonly dy: number;
  /** An inline editor replaces these objects instead of translating them. */
  readonly hidden?: boolean;
  readonly followers?: readonly DrawItem[];
  /** Precomputed translated union (cheap chrome, no sample scans). */
  readonly translatedBounds?: Bounds | null;
}

export interface CommittedRenderer {
  /** Synchronize backing stores with the DOM; returns true when resized. */
  syncSize(): boolean;
  /** Resize + report (facade schedules the frame). */
  resize(): void;
  /**
   * Record content-mutated object ids for the next render's incremental
   * scene update. Pure order/frame changes pass [] (order rebuild only).
   * Accumulated until the next `render` consumes them.
   */
  notifyContentMutated(ids: readonly string[]): void;
  /** Hold confirmed live geometry in paint order until the worker prepares it. */
  retainStrokePreviews(items: readonly DrawItem[]): void;
  /**
   * Geometry-preserving translation (item 1): shift cached DrawItems for
   * `ids` by `(dx,dy)` without recompiling. For pure
   * `TranslateObjectsCommand` commits/undos — never call this for geometry
   * mutations (use `notifyContentMutated` there).
   */
  notifyTranslated(ids: readonly string[], dx: number, dy: number): void;
  /**
   * Render one frame: sync size, rebuild the committed cache when the key
   * changes, composite cached scene, then overlays. Never mutates canonical
   * state.
   */
  render(
    camera: Camera,
    sceneVersion: number,
    previewItems: readonly DrawItem[],
    selection: readonly string[],
    drag?: SelectionDragRenderState | null,
    selectionBounds?: Bounds | null,
    contentTranslation?: Point | null,
  ): void;
  /** Full page layout size for fit/input, independent of the clipped bitmap. */
  viewport(): { width: number; height: number; dpr: number };
  /** Structural counters (large-document regression gate). */
  committedStats(): {
    fullCacheRebuilds: number;
    newlyDrawnCommittedItems: number;
    dragBaseRebuilds: number;
    /**
     * Pure-translation releases promoted from the finished drag frame
     * (no full committed repaint; unrelated items untouched).
     */
    dragPromotions: number;
    /** Pure-translation releases that fell back to a full repaint. */
    translationFullRepaints: number;
    /** Committed items repainted by translation commits. */
    committedItemsRepainted: number;
    progressPending: number;
    /** First ids of the progressive queue (bounded sample for priority tests/dev). */
    progressPendingHead: readonly string[];
    /** Viewport reprioritizations applied to queued work.*/
    priorityReorders: number;
    firstPaintVisible: number | null;
    firstPaintCost: number | null;
    /** Wall-clock ms from renderer creation to first useful paint. */
    firstPaintMs: number | null;
    scene: IncrementalSceneStats;
    cold: ColdSchedulerStats;
  };
  dispose(): void;
}

const HANDLE_PX = 5;

// Shared DOM Worker adapter + factory live in
// `./background-pack-worker.js` so cold compilation and background packing
// use the same narrow adapter and the same literal Vite-compatible
// `new Worker(new URL('./ink-compile.worker.ts', import.meta.url))`.

export function createCommittedSceneRenderer(
  ports: CommittedRendererPorts,
): CommittedRenderer {
  const { model, presentation, page, canvas, root } = ports;
  const selectionRegistry =
    ports.objectRegistry ?? createDefaultSurfaceObjectTypeRegistry();

  // Engine-owned offscreen compositing cache:
  // never attached to the document, never visible.
  const cache = document.createElement('canvas');
  // Dedicated drag-layer canvas: the ephemeral base WITHOUT the moving
  // selection paints here, so drag frames never touch the committed `cache`
  // (a tap-select with a frame between down/up must still composite the
  // full scene afterwards — no version bump rebuilds it).
  const dragCache = document.createElement('canvas');
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  const cacheCtx = cache.getContext('2d') as CanvasRenderingContext2D | null;
  const dragCacheCtx = dragCache.getContext(
    '2d',
  ) as CanvasRenderingContext2D | null;
  // Reused backends: begin() only installs transforms — clearing is
  // explicit (clear), so compositing never wipes painted content.
  const fontFamily = token('--fl-font-sans', 'sans-serif');
  const viewBackend =
    ctx !== null
      ? new CanvasSurfaceRendererBackend(ctx, {
          images: ports.imageResolver,
          fontFamily,
        })
      : null;
  const cacheBackend =
    cacheCtx !== null
      ? new CanvasSurfaceRendererBackend(cacheCtx, {
          images: ports.imageResolver,
          fontFamily,
        })
      : null;
  const dragCacheBackend =
    dragCacheCtx !== null
      ? new CanvasSurfaceRendererBackend(dragCacheCtx, {
          images: ports.imageResolver,
          fontFamily,
        })
      : null;

  let pageWidth = 0;
  let pageHeight = 0;
  let windowX = 0;
  let windowY = 0;
  let cssWidth = 0;
  let cssHeight = 0;
  let dpr = 1;
  let cacheKey = '';
  // Camera fitting can synchronize size before render; keep the cleared
  // buffers invalid until the ensuing paint consumes this resize.
  let sizeDirty = false;
  let disposed = false;
  /**
   * Incremental prepared-scene cache: objectId/logicalId → compiled
   * DrawItem(s). Mutations compile only new/changed keys (O(new), never
   * O(total samples)); unchanged items reuse derived geometry directly.
   * Paint-order references rebuild cheaply (ids only).
   */
  const sceneCache = new IncrementalSceneCache();
  // Lazy cached-vector restore (dense-document reopen): packed cache
  // entries install only for objects the preparation queue actually
  // reaches (strict viewport → prefetch margin → bounded offscreen).
  sceneCache.setCompiledRestoreSource(ports.compiledRestore ?? null);
  const registry = selectionRegistry;
  /**
   * Worker-backed cold compilation: huge deferred strokes
   * compile off the main thread through a single bounded lane. Live
   * writing never enters this scheduler (incremental path). The worker
   * constructs lazily on first need; unsupported hosts fall back to the
   * cooperative main-thread path automatically.
   */
  const coldScheduler = new ColdInkCompileScheduler({
    createWorker: () => createInkCompileWorker(),
  });
  sceneCache.setColdScheduler(coldScheduler);
  let prepared: {
    version: number;
    items: readonly PreparedItem[];
    background: readonly PreparedItem[];
  } | null = null;
  const pendingStrokePreviews = new Map<
    string,
    {
      record: SurfaceModel['objects'][string];
      item: PreparedItem;
    }
  >();

  function retainStrokePreviews(items: readonly DrawItem[]): void {
    for (const item of items) {
      const record = model.objects[item.objectId];
      if (
        record === undefined ||
        item.kind !== 'stroke' ||
        item.liveMesh === undefined ||
        item.liveHeadUpTo !== undefined ||
        estimatePrepareCost(record) <= FIRST_PAINT_MAX_COST
      )
        continue;
      pendingStrokePreviews.set(item.objectId, {
        record,
        item: preparedItems([item])[0]!,
      });
    }
  }

  function withPendingStrokePreviews(
    items: readonly PreparedItem[],
  ): readonly PreparedItem[] {
    if (pendingStrokePreviews.size === 0) return items;
    for (const [id, pending] of pendingStrokePreviews) {
      if (model.objects[id] !== pending.record || sceneCache.isPrepared(id))
        pendingStrokePreviews.delete(id);
    }
    if (pendingStrokePreviews.size === 0) return items;
    const rank = new Map(model.order.map((id, index) => [id, index]));
    return [
      ...items,
      ...[...pendingStrokePreviews.values()].map((p) => p.item),
    ].sort(
      (a, b) =>
        (rank.get(a.item.objectId) ?? 0) - (rank.get(b.item.objectId) ?? 0),
    );
  }

  /** Content-mutated ids accumulated since the last render (scene cache). */
  let pendingContentIds: string[] = [];
  /** Structural counters for the large-document gate. */
  let fullCacheRebuilds = 0;
  let newlyDrawnCommittedItems = 0;
  /** Drag-base rebuilds (once per drag; never counted as full rebuilds). */
  let dragBaseRebuilds = 0;
  /**
   * Pure-translation releases promoted from the finished drag frame
   * (drawImage blit + moved items only; unrelated items untouched).
   */
  let dragPromotions = 0;
  /**
   * Pure-translation releases that fell back to repainting the whole
   * committed scene (unsafe promotion: camera/viewport/background change,
   * unrelated mutation, or missing drag base).
   */
  let translationFullRepaints = 0;
  /**
   * Committed items repainted by translation commits (promotion paints
   * only moved items; full-repaint fallback paints the whole scene).
   */
  let committedItemsRepainted = 0;
  /** Last cache-build inputs for fast-append safety checks. */
  let lastCacheCamera: Camera | null = null;
  let lastCacheViewport: { width: number; height: number; dpr: number } | null =
    null;
  let lastCacheBackgroundLength = -1;
  let lastCacheFrameJson = '';
  /**
   * Drag rendering layer (Slice 2): base cache WITHOUT moving selection
   * (rebuilt once at drag start) plus cached moving-selection geometry
   * drawn with an ephemeral camera shift (no recompile, no full redraw
   * per frame, highlighter painted exactly once).
   */
  let dragBase: {
    excludedKey: string;
    baseItems: readonly PreparedItem[];
    selectionItems: readonly PreparedItem[];
    version: number;
  } | null = null;
  /** Camera the current drag base was painted with (base is view-bound). */
  let lastDragCamera: Camera | null = null;
  /** Progressive offscreen preparation (Slice 8): remaining ids + scheduled flag. */
  let pendingOffscreen: string[] | null = null;
  let progressiveScheduled = false;
  let progressiveHydrating = false;
  /** Camera used for the last progressive-queue reprioritization. */
  let lastPrioritizeCamera: Camera | null = null;
  /**
   * Bounded offscreen lookahead for progressive preparation. The
   * viewport + prefetch-margin band always queues in full; only this many
   * additional offscreen items join the queue. Dense documents (thousands
   * of objects) must not prepare (and repeatedly repaint) the whole
   * document in the background: offscreen work arrives when the camera
   * actually reveals it.
   */
  const PROGRESSIVE_PREFETCH_MAX_ITEMS = 512;
  /** Viewport reprioritizations applied to queued work.*/
  let priorityReorders = 0;
  /** First useful paint milestone (visible ready, before background prefetch). */
  let firstPaintVisibleCount: number | null = null;
  /** Synchronous cost spent on the first paint (samples, item 2). */
  let firstPaintCost: number | null = null;
  /** Wall-clock ms from renderer creation to first useful paint. */
  let firstPaintMs: number | null = null;
  const createdAtMs: number = (() => {
    try {
      if (
        typeof performance !== 'undefined' &&
        typeof performance.now === 'function'
      ) {
        return performance.now();
      }
    } catch {
      // Fall through to Date.now.
    }
    return Date.now();
  })();
  /** Set when progressive slices prepared geometry awaiting repaint. */
  let progressDirty = false;
  let lastProgressRepaint = 0;
  /** Pending rigid translations (item 1): applied without recompiling. */
  let pendingTranslated: Array<{ ids: string[]; dx: number; dy: number }> = [];
  /**
   * Finished drag handoff for pointer-up promotion: captured by `render()`
   * when a drag ends (base image without the selection + moved selection
   * geometry + paint camera), consumed-or-dropped by the next
   * `rebuildCache`. Lets a safe pure-translation commit promote the
   * completed drag frame instead of repainting the document.
   */
  let finishedDrag: {
    base: {
      excludedKey: string;
      baseItems: readonly PreparedItem[];
      selectionItems: readonly PreparedItem[];
      version: number;
    };
    camera: Camera | null;
  } | null = null;
  // The exact immutable entries currently represented by the backing pixels.
  let paintedItems: readonly PreparedItem[] = [];
  let paintedBackground: readonly PreparedItem[] = [];
  // Rasterize repairs without an interior clip: Canvas antialiasing can
  // change along a clip edge that crosses an otherwise untouched stroke.
  let repairCanvas: HTMLCanvasElement | null = null;
  let repairBackend: CanvasSurfaceRendererBackend | null = null;

  /** Repair only changed pixels, replaying overlaps in canonical paint order. */
  function patchCache(camera: Camera, sizeChanged: boolean): boolean {
    if (
      prepared === null ||
      cacheCtx === null ||
      cacheBackend === null ||
      sizeChanged ||
      !sameCamera(lastCacheCamera, camera) ||
      lastCacheFrameJson !== JSON.stringify(model.frame) ||
      JSON.stringify(paintedBackground) !== JSON.stringify(prepared.background)
    )
      return false;
    const next = prepared.items;
    // Progressive preparation usually extends the painted prefix. One fill
    // per new item preserves translucent ink without replaying the old scene.
    const frame = frameBounds(model.frame);
    const borderPad = 2 / dpr / camera.zoom;
    const append =
      next.length > paintedItems.length &&
      paintedItems.every((entry, i) => entry === next[i]) &&
      next.slice(paintedItems.length).every((entry) => {
        if (frame === null || presentation !== 'paint-stage') return true;
        const box = preparedAabb(entry);
        return (
          box.x > borderPad &&
          box.y > borderPad &&
          box.x + box.width < frame.width - borderPad &&
          box.y + box.height < frame.height - borderPad
        );
      });
    let draw: readonly PreparedItem[];
    let repair: {
      left: number;
      top: number;
      width: number;
      height: number;
    } | null = null;
    if (append) {
      draw = next.slice(paintedItems.length);
    } else {
      const previous = new Set(paintedItems);
      const upcoming = new Set(next);
      // A reorder changes overlaps even if all geometry references survive.
      const survivors = paintedItems.filter((entry) => upcoming.has(entry));
      let index = 0;
      for (const entry of next) {
        if (previous.has(entry) && survivors[index++] !== entry) return false;
      }
      const changed = [
        ...paintedItems.filter((entry) => !upcoming.has(entry)),
        ...next.filter((entry) => !previous.has(entry)),
      ];
      if (changed.length === 0) return false; // explicit raster invalidation
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const entry of changed) {
        const box = preparedAabb(entry);
        minX = Math.min(minX, box.x);
        minY = Math.min(minY, box.y);
        maxX = Math.max(maxX, box.x + box.width);
        maxY = Math.max(maxY, box.y + box.height);
      }
      // Align the clip to physical pixels and include antialiasing fringes.
      const left = Math.max(
        0,
        Math.floor((minX - camera.x) * camera.zoom * dpr) - 2,
      );
      const top = Math.max(
        0,
        Math.floor((minY - camera.y) * camera.zoom * dpr) - 2,
      );
      const right = Math.min(
        cache.width,
        Math.ceil((maxX - camera.x) * camera.zoom * dpr) + 2,
      );
      const bottom = Math.min(
        cache.height,
        Math.ceil((maxY - camera.y) * camera.zoom * dpr) + 2,
      );
      if (right <= left || bottom <= top) return true;
      const region = {
        x: camera.x + left / dpr / camera.zoom,
        y: camera.y + top / dpr / camera.zoom,
        width: (right - left) / dpr / camera.zoom,
        height: (bottom - top) / dpr / camera.zoom,
      };
      draw = next.filter((entry) => {
        const box = preparedAabb(entry);
        return (
          box.x <= region.x + region.width &&
          box.x + box.width >= region.x &&
          box.y <= region.y + region.height &&
          box.y + box.height >= region.y
        );
      });
      repair = { left, top, width: right - left, height: bottom - top };
    }
    const scene = {
      frame: model.frame,
      items: draw,
      backgroundItems: append ? [] : prepared.background,
    };
    const viewport = { width: cssWidth, height: cssHeight, dpr };
    if (repair === null) {
      dispatchScene(cacheBackend, scene, camera, viewport);
    } else {
      if (repairCanvas === null)
        repairCanvas = document.createElement('canvas');
      if (
        repairCanvas.width !== cache.width ||
        repairCanvas.height !== cache.height
      ) {
        repairCanvas.width = cache.width;
        repairCanvas.height = cache.height;
      }
      const repairCtx = repairCanvas.getContext('2d');
      if (repairCtx === null) return false;
      repairBackend ??= new CanvasSurfaceRendererBackend(repairCtx, {
        images: ports.imageResolver,
        fontFamily,
      });
      paintPaperAndBackground(camera, repairCtx);
      dispatchScene(repairBackend, scene, camera, viewport);
      paintOutline(camera, repairCtx);
      cacheCtx.save();
      cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
      const { left, top, width, height } = repair;
      cacheCtx.clearRect(left, top, width, height);
      cacheCtx.drawImage(
        repairCanvas,
        left,
        top,
        width,
        height,
        left,
        top,
        width,
        height,
      );
      cacheCtx.restore();
    }
    newlyDrawnCommittedItems += draw.length;
    lastCacheBackgroundLength = prepared.background.length;
    return true;
  }

  /** Minimum interval between progressive fill repaints. */
  const PROGRESS_REPAINT_MS = 16;

  function viewportSurfaceBounds(camera: Camera): Bounds {
    return viewportSurfaceRect(camera, { width: cssWidth, height: cssHeight });
  }

  /**
   * Cost-bounded leading subset of ids (same budget rule as first paint):
   * panning into a dense viewport prepares an affordable slice
   * synchronously and queues the remainder progressively, so a camera
   * move can never compile thousands of samples in one frame.
   */
  function costBoundedIds(
    ids: readonly string[],
    maxCost = FIRST_PAINT_MAX_COST,
  ): string[] {
    const out: string[] = [];
    let spent = 0;
    for (const id of ids) {
      const record = model.objects[id];
      if (record === undefined) continue;
      const cost = estimatePrepareCost(record);
      if (spent + cost > maxCost) break;
      out.push(id);
      spent += cost;
    }
    return out;
  }

  function queryVisibleWithMargin(
    camera: Camera,
    marginExtents: number,
  ): readonly string[] {
    const visible = viewportSurfaceBounds(camera);
    const query: Bounds = {
      x: visible.x - visible.width * marginExtents,
      y: visible.y - visible.height * marginExtents,
      width: visible.width * (1 + marginExtents * 2),
      height: visible.height * (1 + marginExtents * 2),
    };
    if (ports.queryVisible !== undefined) {
      try {
        return ports.queryVisible(query);
      } catch {
        return [...model.order];
      }
    }
    return [...model.order];
  }

  /**
   * Preparation-priority bands for one camera: strict-viewport
   * ids first, then the prefetch margin, then the rest — canonical paint
   * order within each band. Paint order is untouched; only the
   * progressive/cold queue order changes.
   */
  function priorityBands(camera: Camera): {
    strict: Set<string>;
    margin: Set<string>;
  } {
    let strict: readonly string[] = [];
    let margin: readonly string[] = [];
    if (ports.queryVisible !== undefined) {
      try {
        strict = ports.queryVisible(viewportSurfaceBounds(camera));
      } catch {
        strict = [];
      }
      try {
        margin = queryVisibleWithMargin(camera, 1);
      } catch {
        margin = [];
      }
    } else {
      strict = [...model.order];
      margin = [...model.order];
    }
    return { strict: new Set(strict), margin: new Set(margin) };
  }

  /**
   * Bounded progressive queue for one camera: the full viewport/strict
   * and prefetch-margin bands, plus at most
   * `PROGRESSIVE_PREFETCH_MAX_ITEMS` offscreen items. Keeps background
   * preparation and its fill repaints proportional to the visible area,
   * not to the total document size.
   */
  function boundedPendingQueue(camera: Camera): string[] | null {
    const { strict, margin } = priorityBands(camera);
    let prefetch = 0;
    const out: string[] = [];
    for (const id of orderByPreparationPriority(
      model.order,
      (candidate) => sceneCache.isPrepared(candidate),
      strict,
      margin,
    )) {
      if (strict.has(id) || margin.has(id)) {
        out.push(id);
        continue;
      }
      if (prefetch >= PROGRESSIVE_PREFETCH_MAX_ITEMS) continue;
      prefetch += 1;
      out.push(id);
    }
    return out.length > 0 ? out : null;
  }

  /**
   * Rebuild the progressive queue in preparation-priority bands for the
   * current camera and mirror the bands into the cold scheduler queue
   * (key space). Already-compiled geometry is never discarded — only
   * queued, unprepared work moves. Never throws.
   */
  function reprioritizePending(camera: Camera): void {
    if (pendingOffscreen === null || pendingOffscreen.length === 0) return;
    try {
      pendingOffscreen = boundedPendingQueue(camera);
      lastPrioritizeCamera = { ...camera };
      priorityReorders += 1;
      if (pendingOffscreen !== null) {
        coldScheduler.reorderQueue(
          sceneCache.preparationKeysFor(model, pendingOffscreen),
        );
      }
    } catch {
      // Reprioritization never breaks preparation.
    }
  }

  function sameCamera(a: Camera | null, b: Camera): boolean {
    return a !== null && a.x === b.x && a.y === b.y && a.zoom === b.zoom;
  }

  function scheduleProgressive(): void {
    if (progressiveScheduled || progressiveHydrating) return;
    if (pendingOffscreen === null || pendingOffscreen.length === 0) return;
    progressiveScheduled = true;
    const run = (): void => {
      progressiveScheduled = false;
      if (disposed || pendingOffscreen === null) return;
      if (pendingOffscreen.length === 0) {
        pendingOffscreen = null;
        return;
      }
      // Bounded sync slice (item 3, genuine budget): over-budget huge
      // strokes defer untouched (no sync monopoly).
      const { remaining, compiled } = sceneCache.prepareMore(
        model,
        registry,
        pendingOffscreen,
        3,
      );
      pendingOffscreen = [...remaining];
      if (compiled > 0) progressDirty = true;
      // Async hydration for deferred huge heads (item 3, resumable): when
      // a sync slice compiles nothing but defers (huge head blocks the
      // queue), hydrate one head via the yielding async compiler off the
      // critical path, then continue progressively. Identical geometry.
      const deferredOnly =
        compiled === 0 &&
        pendingOffscreen.length > 0 &&
        sceneCache.statsSnapshot().deferredForCost > 0;
      if (deferredOnly) {
        const head = pendingOffscreen[0]!;
        const generation = sceneCache.currentGeneration();
        progressiveHydrating = true;
        void sceneCache.prepareOneAsync(model, registry, head).then((ok) => {
          progressiveHydrating = false;
          if (disposed) return;
          if (!ok && generation !== sceneCache.currentGeneration()) {
            // An edit superseded this job and rebuilt the pending queue.
            // Retry that queue; never discard its (possibly different) head.
            scheduleProgressive();
            return;
          }
          if (ok) {
            ports.onContentPrepared?.([head]);
            progressDirty = true;
            // Drop the hydrated head (prepared now) and continue.
            if (pendingOffscreen !== null) {
              pendingOffscreen = pendingOffscreen.filter(
                (id) => !sceneCache.isPrepared(id),
              );
              if (pendingOffscreen.length === 0) {
                pendingOffscreen = null;
                if (progressDirty) ports.scheduleRender?.();
                return;
              }
            }
            ports.scheduleRender?.();
            scheduleProgressive();
          } else {
            // Async failed: drop the head to avoid a busy idle loop (content
            // stays unprepared, never blocks; retry on next pan/open).
            if (pendingOffscreen !== null) {
              pendingOffscreen = pendingOffscreen.slice(1);
              if (pendingOffscreen.length === 0) pendingOffscreen = null;
            }
            if (pendingOffscreen !== null && pendingOffscreen.length > 0)
              scheduleProgressive();
          }
        });
        return;
      }
      if (pendingOffscreen.length > 0) {
        // Repaint the fill cadence-bound (default 150ms) so newly prepared
        // geometry appears without a repaint per slice.
        const now = Date.now();
        if (now - lastProgressRepaint >= PROGRESS_REPAINT_MS) {
          ports.scheduleRender?.();
        }
        scheduleProgressive();
      } else {
        pendingOffscreen = null;
        // Final fill always repaints (if anything was prepared off-frame).
        if (progressDirty) ports.scheduleRender?.();
      }
    };
    // Visible missing ink is foreground work. Idle callbacks can wait tens
    // of milliseconds between tiny slices, stretching an ordinary page to
    // seconds. Yield between bounded slices, but reserve idle time only for
    // offscreen prefetch.
    const visible =
      lastPrioritizeCamera === null
        ? null
        : viewportSurfaceBounds(lastPrioritizeCamera);
    const visibleIds =
      visible === null ? [] : (ports.queryVisible?.(visible) ?? model.order);
    if (visibleIds.some((id) => !sceneCache.isPrepared(id))) {
      setTimeout(run, 0);
      return;
    }
    try {
      const ric = (
        globalThis as unknown as {
          requestIdleCallback?: (
            cb: (deadline: { timeRemaining(): number }) => void,
            opts?: { timeout: number },
          ) => number;
        }
      ).requestIdleCallback;
      if (typeof ric === 'function') {
        ric(() => run(), { timeout: 100 });
      } else if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => run());
      } else {
        setTimeout(() => run(), 0);
      }
    } catch {
      try {
        setTimeout(() => run(), 0);
      } catch {
        // Progressive never blocks paint.
      }
    }
  }

  const readDpr = (): number =>
    typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
      ? Math.max(window.devicePixelRatio, 1)
      : 1;

  function token(name: string, fallback: string): string {
    const value = getComputedStyle(root).getPropertyValue(name).trim();
    return value === '' ? fallback : value;
  }

  function syncSize(): boolean {
    const rect = page.getBoundingClientRect();
    // CSS layout remains authoritative during the pager's transform preview.
    const nextPageW = Math.max(
      ports.renderViewport !== undefined
        ? page.clientWidth || rect.width || 800
        : Math.round(rect.width || page.clientWidth || 800),
      1,
    );
    const previewScale = rect.width / nextPageW || 1;
    const nextPageH = Math.max(
      ports.renderViewport !== undefined
        ? rect.height / previewScale || page.clientHeight || 600
        : Math.round(rect.height || page.clientHeight || 600),
      1,
    );
    let left = 0;
    let top = 0;
    let right = nextPageW;
    let bottom = nextPageH;
    if (ports.renderViewport !== undefined) {
      const host = ports.renderViewport;
      const clip = host.getBoundingClientRect();
      const scaleX = rect.width / nextPageW || 1;
      const scaleY = rect.height / nextPageH || 1;
      const clipLeft = clip.left + host.clientLeft;
      const clipTop = clip.top + host.clientTop;
      const clipRight = clipLeft + (host.clientWidth || clip.width);
      const clipBottom = clipTop + (host.clientHeight || clip.height);
      // Small prefetch margin, expressed in page CSS pixels. Do not fit the
      // document to this intersection: it only moves the raster's origin.
      const margin = 64;
      left = Math.min(
        nextPageW,
        Math.max(0, Math.floor((clipLeft - rect.left) / scaleX - margin)),
      );
      top = Math.min(
        nextPageH,
        Math.max(0, Math.floor((clipTop - rect.top) / scaleY - margin)),
      );
      right = Math.max(
        left,
        Math.min(
          nextPageW,
          Math.ceil((clipRight - rect.left) / scaleX + margin),
        ),
      );
      bottom = Math.max(
        top,
        Math.min(
          nextPageH,
          Math.ceil((clipBottom - rect.top) / scaleY + margin),
        ),
      );
      canvas.style.position = 'absolute';
      canvas.style.left = `${left}px`;
      canvas.style.top = `${top}px`;
      canvas.style.width = `${right - left}px`;
      canvas.style.height = `${bottom - top}px`;
    }
    const nextW = Math.max(right - left, 1);
    const nextH = Math.max(bottom - top, 1);
    // Retain a final allocation guard for unusually large host viewports.
    // Notebook raster size now follows the visible window, never page zoom.
    const nextDpr = Math.min(readDpr(), 4096 / nextW, 4096 / nextH);
    const changed =
      nextW !== cssWidth ||
      nextH !== cssHeight ||
      nextDpr !== dpr ||
      left !== windowX ||
      top !== windowY ||
      nextPageW !== pageWidth ||
      nextPageH !== pageHeight;
    pageWidth = nextPageW;
    pageHeight = nextPageH;
    windowX = left;
    windowY = top;
    if (!changed) return false;
    sizeDirty = true;
    cssWidth = nextW;
    cssHeight = nextH;
    dpr = nextDpr;
    const w = Math.max(Math.round(cssWidth * dpr), 1);
    const h = Math.max(Math.round(cssHeight * dpr), 1);
    for (const buffer of [canvas, cache, dragCache]) {
      if (buffer.width !== w) buffer.width = w;
      if (buffer.height !== h) buffer.height = h;
    }
    // Size/origin changes invalidate the drag base; the next drag frame
    // rebuilds it even when the allocation dimensions stayed unchanged.
    dragBase = null;
    return true;
  }

  function resize(): void {
    syncSize();
  }

  function notifyContentMutated(ids: readonly string[]): void {
    for (const id of ids) {
      const record = model.objects[id];
      pendingStrokePreviews.delete(record ? (logicalIdOf(record) ?? id) : id);
      if (!pendingContentIds.includes(id)) pendingContentIds.push(id);
    }
  }

  function notifyTranslated(
    ids: readonly string[],
    dx: number,
    dy: number,
  ): void {
    if (ids.length === 0 || (dx === 0 && dy === 0)) return;
    const shifted = new Set<string>();
    for (const id of ids) {
      const record = model.objects[id];
      const key = record ? (logicalIdOf(record) ?? id) : id;
      if (shifted.has(key)) continue;
      shifted.add(key);
      const pending = pendingStrokePreviews.get(key);
      if (pending !== undefined) {
        pending.item.transform.tx += dx;
        pending.item.transform.ty += dy;
      }
    }
    pendingTranslated.push({ ids: [...ids], dx, dy });
  }

  function paintPaperAndBackground(
    camera: Camera,
    target: CanvasRenderingContext2D | null = cacheCtx,
  ): void {
    if (target === null) return;
    target.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The bounded sheet is the only paper. Keep the surrounding Paint stage
    // transparent so the host's light/dark surface remains visible instead
    // of baking a light canvas behind it.
    target.clearRect(0, 0, cssWidth, cssHeight);
    if (presentation === 'embedded-paper') {
      target.fillStyle = '#ffffff';
      target.fillRect(0, 0, cssWidth, cssHeight);
    }

    const zoom = camera.zoom;
    const frame = frameBounds(model.frame);
    const paper = presentation === 'paint-stage' ? surfacePaper(model) : null;
    if (paper !== null && frame === null) {
      target.fillStyle = paper.paperColor ?? '#ffffff';
      target.fillRect(0, 0, cssWidth, cssHeight);
    }
    if (frame !== null) {
      const pageX = -camera.x * zoom;
      const pageY = -camera.y * zoom;
      const pageWidth = frame.width * zoom;
      const pageHeight = frame.height * zoom;

      // Paint owns a physical sheet. Notebook already supplies the paper
      // shell, so its embedded surface stays full-bleed and shadow-free.
      if (presentation !== 'embedded-overlay') {
        target.save();
        if (presentation === 'paint-stage') {
          target.shadowColor = 'rgba(32, 29, 24, 0.18)';
          target.shadowBlur = 16;
          target.shadowOffsetY = 4;
        }
        target.fillStyle = paper?.paperColor ?? '#ffffff';
        target.fillRect(pageX, pageY, pageWidth, pageHeight);
        target.restore();
      }
    }
    if (paper !== null && paper.template !== 'froglight.blank') {
      const spacing =
        paper.spacing ?? defaultPaperSpacingForTemplate(paper.template);
      const visible = viewportSurfaceRect(camera, {
        width: cssWidth,
        height: cssHeight,
      });
      const minX = Math.max(frame === null ? -Infinity : 0, visible.x);
      const minY = Math.max(frame === null ? -Infinity : 0, visible.y);
      const maxX = Math.min(
        frame?.width ?? Infinity,
        visible.x + visible.width,
      );
      const maxY = Math.min(
        frame?.height ?? Infinity,
        visible.y + visible.height,
      );
      if (maxX > minX && maxY > minY && spacing * zoom >= 9) {
        target.save();
        if (frame !== null) {
          target.beginPath();
          target.rect(
            -camera.x * zoom,
            -camera.y * zoom,
            frame.width * zoom,
            frame.height * zoom,
          );
          target.clip();
        }
        target.setTransform(
          dpr * zoom,
          0,
          0,
          dpr * zoom,
          -camera.x * zoom * dpr,
          -camera.y * zoom * dpr,
        );
        target.fillStyle = 'rgba(96, 125, 189, 0.30)';
        target.strokeStyle = 'rgba(96, 125, 189, 0.30)';
        target.lineWidth = 1 / zoom;
        target.beginPath();
        const startX = Math.ceil(minX / spacing) * spacing;
        const startY = Math.ceil(minY / spacing) * spacing;
        if (paper.template === 'froglight.dots') {
          for (
            let x =
              Math.ceil((minX - spacing / 2) / spacing) * spacing + spacing / 2;
            x <= maxX;
            x += spacing
          ) {
            for (
              let y =
                Math.ceil((minY - spacing / 2) / spacing) * spacing +
                spacing / 2;
              y <= maxY;
              y += spacing
            ) {
              target.moveTo(x + 1.1 / zoom, y);
              target.arc(x, y, 1.1 / zoom, 0, Math.PI * 2);
            }
          }
          target.fill();
        } else if (
          paper.template === 'froglight.grid' ||
          paper.template === 'froglight.lined' ||
          paper.template === 'froglight.cornell'
        ) {
          if (paper.template === 'froglight.grid') {
            for (let x = startX; x <= maxX; x += spacing) {
              target.moveTo(x, minY);
              target.lineTo(x, maxY);
            }
          }
          for (let y = startY; y <= maxY; y += spacing) {
            target.moveTo(minX, y);
            target.lineTo(maxX, y);
          }
          if (paper.template === 'froglight.cornell' && frame !== null) {
            target.moveTo(frame.width * 0.32, 0);
            target.lineTo(frame.width * 0.32, frame.height * 0.78);
            target.moveTo(0, frame.height * 0.78);
            target.lineTo(frame.width, frame.height * 0.78);
          }
          target.stroke();
        }
        target.restore();
      }
    }
  }

  function paintOutline(
    camera: Camera,
    target: CanvasRenderingContext2D | null = cacheCtx,
  ): void {
    if (target === null) return;
    const frame = frameBounds(model.frame);
    const zoom = camera.zoom;
    if (frame !== null && presentation === 'paint-stage') {
      const pageX = -camera.x * zoom;
      const pageY = -camera.y * zoom;
      target.strokeStyle = token(
        '--fl-border-strong',
        'rgba(55, 53, 47, 0.16)',
      );
      target.lineWidth = 1;
      target.setTransform(dpr, 0, 0, dpr, 0, 0);
      target.strokeRect(pageX, pageY, frame.width * zoom, frame.height * zoom);
    }
  }

  /**
   * Promote the finished drag frame into the committed cache (final
   * scalability pass §5): the drag layer already holds `base without
   * moving selection` and the prepared transforms already carry the
   * committed translation, so `drawImage(base) + draw(moved selection)`
   * reproduces the final drag frame exactly — independent of total
   * document object count. Returns true when promoted (caller returns),
   * false when any safety condition fails (caller takes the normal full
   * repaint fallback).
   *
   * Highlighter safety: the base was painted once without the selection
   * and the selection paints exactly once here — never in the base, never
   * twice.
   */
  function promoteFinishedDrag(
    camera: Camera,
    viewport: { width: number; height: number; dpr: number },
    background: readonly PreparedItem[],
    frameJson: string,
    translated: readonly { ids: string[]; dx: number; dy: number }[],
    sizeChanged: boolean,
    commitVersion: number,
    finished: {
      base: {
        excludedKey: string;
        baseItems: readonly PreparedItem[];
        selectionItems: readonly PreparedItem[];
        version: number;
      };
      camera: Camera | null;
    } | null,
  ): boolean {
    if (finished === null) return false;
    if (prepared === null) return false;
    if (cacheCtx === null || cacheBackend === null) return false;
    if (sizeChanged) return false;
    const { base, camera: dragCamera } = finished;
    if (dragCamera === null) return false;
    if (lastCacheCamera === null || lastCacheViewport === null) return false;
    // Camera/viewport/DPR unchanged: the base pixels are still valid.
    if (!sameCamera(dragCamera, camera)) return false;
    if (!sameCamera(lastCacheCamera, camera)) return false;
    if (
      viewport.width !== lastCacheViewport.width ||
      viewport.height !== lastCacheViewport.height ||
      viewport.dpr !== lastCacheViewport.dpr
    ) {
      return false;
    }
    // Background/frame unchanged.
    if (background.length !== lastCacheBackgroundLength) return false;
    if (frameJson !== lastCacheFrameJson) return false;
    // Base was built from the current prepared scene (no async image
    // readiness or second commit slipped between drag frames and release).
    if (base.version !== prepared.version) return false;
    // Pure translation: every translated id resolves into the dragged
    // selection (chunk ids resolve to their joint logical key). Anything
    // else — unrelated mutation, reconciled followers handled separately
    // via content ids (non-empty there, so unreachable here) — is unsafe.
    const selectionIds = new Set(
      base.selectionItems.map((entry) => entry.item.objectId),
    );
    for (const batch of translated) {
      for (const id of batch.ids) {
        const record = model.objects[id];
        if (record === undefined) return false;
        const expected = logicalIdOf(record) ?? id;
        if (!selectionIds.has(expected) && !selectionIds.has(id)) return false;
      }
    }
    // Safe: blit the base (paper + background + unmoved items, already in
    // device pixels) then paint only the moved selection at its final
    // prepared transforms. Unrelated committed items repaint: zero.
    // The base is transparent where the moving selection sat (that is the
    // point of excluding it), so the stale committed bitmap must be
    // cleared before the blit — otherwise those pre-drag pixels survive
    // as an unselectable ghost.
    cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
    cacheCtx.clearRect(0, 0, cache.width, cache.height);
    cacheCtx.drawImage(dragCache, 0, 0);
    cacheBackend.begin(camera, viewport);
    for (const entry of base.selectionItems) {
      cacheBackend.draw(entry.item, entry.transform);
    }
    cacheBackend.end();
    paintOutline(camera);
    dragPromotions += 1;
    committedItemsRepainted += base.selectionItems.length;
    newlyDrawnCommittedItems += base.selectionItems.length;
    lastCacheCamera = { ...camera };
    lastCacheViewport = { ...viewport };
    lastCacheBackgroundLength = background.length;
    lastCacheFrameJson = frameJson;
    prepared = {
      version: commitVersion,
      items: prepared.items,
      background,
    };
    return true;
  }

  /** Rebuild the committed-content layer (model, camera, or size changed). */
  function rebuildCache(
    camera: Camera,
    sceneVersion: number,
    sizeChanged: boolean,
  ): void {
    // Pick up newly added (or undo-restored) image objects; loaded bitmaps
    // arrive asynchronously and re-render through the cache's onReady hook.
    // Request only when the scene (not just the camera) changed — pans
    // repaint from cached items without re-requesting.
    const viewport = { width: cssWidth, height: cssHeight, dpr };
    const sceneChanged = prepared === null || prepared.version !== sceneVersion;
    if (!sceneChanged) {
      // Camera/size-only: repaint from cached items (no recompile, no
      // background re-read). With lazy open, newly exposed viewport items
      // are prepared incrementally (no full recompile).
      if (ports.queryVisible !== undefined && prepared !== null) {
        try {
          const visibleIds = queryVisibleWithMargin(camera, 1);
          const missing = visibleIds.filter((id) => !sceneCache.isPrepared(id));
          if (missing.length > 0) {
            // Cost-bounded synchronous subset: an affordable slice shows
            // immediately; the remainder joins the bounded progressive
            // queue instead of compiling the whole viewport in one frame.
            const affordable = costBoundedIds(missing);
            sceneCache.prepareVisible(model, registry, affordable);
            // Merge newly prepared into the prepared set (paint order).
            // prepared.items currently holds previously visible; rebuild
            // ordered full-prepared list cheaply (ids only) for future pans.
            const refreshed = sceneCache.update(model, registry, []);
            prepared = {
              version: prepared.version,
              items: refreshed,
              background: prepared.background,
            };
            pendingOffscreen = boundedPendingQueue(camera);
            lastPrioritizeCamera = { ...camera };
            scheduleProgressive();
          }
          // The viewport moved under background preparation:
          // reprioritize queued — never completed — work so newly
          // visible content jumps ahead of irrelevant offscreen work.
          // Valid compiled geometry is never discarded.
          if (
            pendingOffscreen !== null &&
            pendingOffscreen.length > 0 &&
            !sameCamera(lastPrioritizeCamera, camera)
          ) {
            reprioritizePending(camera);
          }
        } catch {
          // Lazy prepare never breaks panning.
        }
      }
      if (ports.imageCache !== null && ports.imageCache !== undefined) {
        // Camera moves still need image readiness for the current surface;
        // keep the legacy request-on-repaint behavior for image tests.
        void ports.imageCache.requestSurface(model);
      }
    } else if (ports.imageCache !== null && ports.imageCache !== undefined) {
      void ports.imageCache.requestSurface(model);
    }
    if (sceneChanged) {
      // Paper/background items never carry derived translation (they are
      // rebuilt from template policy, not translated), so they wrap once
      // here with zero transforms.
      const background = preparedItems(ports.backgroundItems?.() ?? []);
      const frameJson = JSON.stringify(model.frame);
      const contentIds = [...pendingContentIds];
      pendingContentIds = [];
      // Rigid translations first (item 1): shift cached DrawItems without
      // recompiling, then fold into the prepared order (ids only).
      const translated = [...pendingTranslated];
      pendingTranslated = [];
      if (translated.length > 0 && prepared !== null) {
        for (const t of translated) {
          sceneCache.notifyTranslated(t.ids, t.dx, t.dy);
        }
        // Content ids that were also translated need no recompile — drop
        // them from the mutation set (translation already applied).
        const translatedIds = new Set(translated.flatMap((t) => t.ids));
        for (let ci = contentIds.length - 1; ci >= 0; ci--) {
          if (translatedIds.has(contentIds[ci]!)) contentIds.splice(ci, 1);
        }
        prepared = {
          version: prepared.version,
          items: withPendingStrokePreviews(
            sceneCache.update(
              model,
              registry,
              contentIds,
              FIRST_PAINT_MAX_COST,
            ),
          ),
          background: prepared.background,
        };
        // Fall through to paint the translated scene below (no recompile).
        // When there are no other content changes, prefer drag promotion:
        // the finished drag frame already shows base + moved selection, so
        // blit it into the committed cache (O(moved)) instead of
        // repainting the whole document. Falls back to a full repaint only
        // when promotion is unsafe (camera/viewport/background changed,
        // unrelated mutation, or no drag base).
        if (contentIds.length === 0 && prepared !== null) {
          const finished = finishedDrag;
          finishedDrag = null;
          if (
            promoteFinishedDrag(
              camera,
              viewport,
              background,
              frameJson,
              translated,
              sizeChanged,
              sceneVersion,
              finished,
            )
          ) {
            return;
          }
          if (cacheCtx !== null && cacheBackend !== null) {
            paintPaperAndBackground(camera);
            dispatchScene(
              cacheBackend,
              {
                frame: model.frame,
                items: prepared.items,
                backgroundItems: prepared.background,
              },
              camera,
              viewport,
            );
          }
          paintOutline(camera);
          translationFullRepaints += 1;
          committedItemsRepainted += prepared.items.length;
          // Translated repaint is not a full rebuild (no recompile).
          lastCacheCamera = { ...camera };
          lastCacheViewport = { ...viewport };
          lastCacheBackgroundLength = background.length;
          lastCacheFrameJson = frameJson;
          prepared = {
            version: sceneVersion,
            items: prepared.items,
            background,
          };
          return;
        }
      }
      // Lazy open (Slice 7, repaired item 2): first paint prepares a
      // COST-bounded leading subset of visible geometry — never a fixed
      // item count (120 tiny vs 120 huge strokes differ radically). The
      // paper/background always paints immediately, even when visible
      // geometry is expensive (zero items prepared if the head alone
      // exceeds the budget — hydration follows progressively).
      if (
        prepared === null &&
        contentIds.length === 0 &&
        ports.queryVisible !== undefined
      ) {
        const visibleIds = queryVisibleWithMargin(camera, 1);
        const visibleSet = new Set(visibleIds);
        const firstPaintIds: string[] = [];
        let spentCost = 0;
        for (const id of model.order) {
          if (!visibleSet.has(id)) continue;
          const record = model.objects[id];
          if (record === undefined) continue;
          const cost = estimatePrepareCost(record);
          if (spentCost + cost > FIRST_PAINT_MAX_COST) break;
          firstPaintIds.push(id);
          spentCost += cost;
        }
        const nextVisible =
          firstPaintIds.length > 0
            ? sceneCache.prepareVisible(model, registry, firstPaintIds)
            : [];
        prepared = {
          version: sceneVersion,
          items: nextVisible,
          background,
        };
        firstPaintVisibleCount = nextVisible.length;
        firstPaintCost = spentCost;
        try {
          firstPaintMs =
            (typeof performance !== 'undefined' &&
            typeof performance.now === 'function'
              ? performance.now()
              : Date.now()) - createdAtMs;
        } catch {
          firstPaintMs = null;
        }
        lastProgressRepaint = Date.now();
        // Progressive offscreen (Slice 8): unprepared ids in
        // preparation-priority bands (visible remainder → prefetch
        // margin → bounded offscreen lookahead), canonical paint order
        // within each band. prepareMore skips cached keys cheaply, so
        // chunk siblings already pulled in cost nothing. The offscreen
        // lookahead is capped so a dense document never prepares (and
        // repeatedly repaints) thousands of invisible objects at open.
        pendingOffscreen = boundedPendingQueue(camera);
        lastPrioritizeCamera = { ...camera };
        scheduleProgressive();
        // Paint visible-only base (first useful paint, before prefetch).
        if (cacheCtx !== null && cacheBackend !== null) {
          paintPaperAndBackground(camera);
          dispatchScene(
            cacheBackend,
            {
              frame: model.frame,
              items: nextVisible,
              backgroundItems: background,
            },
            camera,
            viewport,
          );
        }
        paintOutline(camera);
        fullCacheRebuilds += 1;
        newlyDrawnCommittedItems += nextVisible.length;
        lastCacheCamera = { ...camera };
        lastCacheViewport = { ...viewport };
        lastCacheBackgroundLength = background.length;
        lastCacheFrameJson = frameJson;
        return;
      }
      let nextItems: readonly PreparedItem[];
      if (prepared !== null && contentIds.length > 0 && !sizeChanged) {
        // Incremental scene compilation (O(new), never O(total)).
        nextItems = sceneCache.update(
          model,
          registry,
          contentIds,
          FIRST_PAINT_MAX_COST,
        );
      } else if (prepared !== null && contentIds.length === 0 && !sizeChanged) {
        // Order/frame-only or unknown; rebuild order refs cheaply without
        // recompiling content (no new geometry).
        nextItems = sceneCache.update(model, registry, []);
      } else {
        // Unknown mutation set (version bump without content ids, size
        // change, or first paint): full rebuild fallback. Production
        // pen/undo paths always supply content ids, so simple appends
        // never take this branch.
        nextItems = sceneCache.fullRebuild(model, registry);
      }
      prepared = {
        version: sceneVersion,
        items: withPendingStrokePreviews(nextItems),
        background,
      };
      if (contentIds.length > 0) {
        ports.onContentPrepared?.(
          contentIds.filter((id) => {
            const record = model.objects[id];
            return (
              record === undefined ||
              sceneCache.isPrepared(logicalIdOf(record) ?? id)
            );
          }),
        );
        pendingOffscreen = boundedPendingQueue(camera);
        lastPrioritizeCamera = { ...camera };
        scheduleProgressive();
      }
      if (patchCache(camera, sizeChanged || translated.length > 0)) return;
      // Full rebuild fallback (reorder/delete/transform/camera/size/
      // background/undo-broad/unknown): clear and redraw everything.
      if (cacheCtx === null) {
        lastCacheCamera = { ...camera };
        lastCacheViewport = { ...viewport };
        lastCacheBackgroundLength = background.length;
        lastCacheFrameJson = frameJson;
        return;
      }
      paintPaperAndBackground(camera);
      if (cacheBackend !== null) {
        dispatchScene(
          cacheBackend,
          {
            frame: model.frame,
            items: prepared.items,
            backgroundItems: prepared.background,
          },
          camera,
          viewport,
        );
      }
      paintOutline(camera);
      fullCacheRebuilds += 1;
      newlyDrawnCommittedItems += prepared.items.length;
      lastCacheCamera = { ...camera };
      lastCacheViewport = { ...viewport };
      lastCacheBackgroundLength = background.length;
      lastCacheFrameJson = frameJson;
      return;
    }
    // Scene unchanged (camera/size-only move): repaint the raster from
    // cached items (no recompile). Size changes already resized (cleared)
    // the backing stores above, so this always repaints fully.
    if (cacheCtx === null) return;
    const cached = prepared;
    if (cached === null) return;
    if (patchCache(camera, sizeChanged)) return;
    paintPaperAndBackground(camera);
    if (cacheBackend === null) return;
    dispatchScene(
      cacheBackend,
      {
        frame: model.frame,
        items: cached.items,
        backgroundItems: cached.background,
      },
      camera,
      viewport,
    );
    paintOutline(camera);
    fullCacheRebuilds += 1;
    newlyDrawnCommittedItems += cached.items.length;
    lastCacheCamera = { ...camera };
    lastCacheViewport = { ...viewport };
    // Order/background/frame unchanged here; refresh snapshots anyway.
    lastCacheBackgroundLength = cached.background.length;
    lastCacheFrameJson = JSON.stringify(model.frame);
  }

  function drawSelectionChrome(camera: Camera, ids: readonly string[]): void {
    if (ctx === null) return;
    paintSelectionChrome(
      ctx,
      dpr,
      token,
      model,
      camera,
      ids,
      selectionRegistry,
    );
  }

  function drawObjectResizeHandle(
    camera: Camera,
    ids: readonly string[],
  ): void {
    if (ctx === null) return;
    paintObjectResizeHandle(
      ctx,
      dpr,
      token,
      model,
      camera,
      ids,
      selectionRegistry,
    );
    const handles = selectionHandles(
      model,
      selectionRegistry,
      ids,
      camera.zoom,
    );
    if (handles.length === 0) return;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.setLineDash([]);
    ctx.fillStyle = token('--fl-surface-editor', '#fff');
    ctx.strokeStyle = token('--fl-accent', '#7c6cf0');
    for (const handle of handles) {
      const anchor = handle.kind === 'anchor';
      ctx.fillStyle = anchor
        ? token('--fl-accent', '#7c6cf0')
        : token('--fl-surface-editor', '#fff');
      ctx.strokeStyle = anchor
        ? token('--fl-surface-editor', '#fff')
        : token('--fl-accent', '#7c6cf0');
      ctx.lineWidth = anchor ? 2 : 1.25;
      ctx.beginPath();
      ctx.arc(
        (handle.x - camera.x) * camera.zoom,
        (handle.y - camera.y) * camera.zoom,
        anchor ? 3 : 4,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawResizeHandles(): void {
    if (ctx === null) return;
    // Facade supplies camera via render(); recompute rect from current?
    // The caller passes camera, but resize handles need it: handled in
    // render() which calls this with camera in scope. To keep this helper
    // pure, render() inlines the call (see below).
  }

  function drawSelectionChromeFromBounds(camera: Camera, bounds: Bounds): void {
    if (ctx === null) return;
    // Cheap chrome (Slice 10): precomputed translated union, no sample scans.
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const x = (bounds.x - camera.x) * camera.zoom;
    const y = (bounds.y - camera.y) * camera.zoom;
    ctx.strokeStyle = token('--fl-accent', '#7c6cf0');
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([]);
    ctx.strokeRect(
      x - 3,
      y - 3,
      bounds.width * camera.zoom + 6,
      bounds.height * camera.zoom + 6,
    );
    ctx.setLineDash([]);
    ctx.restore();
  }

  function render(
    camera: Camera,
    sceneVersion: number,
    previewItems: readonly DrawItem[],
    selection: readonly string[],
    drag?: SelectionDragRenderState | null,
    selectionBounds?: Bounds | null,
    contentTranslation?: Point | null,
  ): void {
    if (disposed || ctx === null) return;
    // Layout truth before anything paints: a changed page box resizes
    // the backing stores and forces a cache rebuild this frame.
    const sizeChanged = syncSize() || sizeDirty;
    sizeDirty = false;
    // Input and DOM overlays retain full-page coordinates. Only raster passes
    // see this translated camera; scale remains the full-page fit scale.
    camera = {
      x: camera.x + windowX / camera.zoom,
      y: camera.y + windowY / camera.zoom,
      zoom: camera.zoom,
    };
    const hasDrag = drag !== undefined && drag !== null && drag.ids.length > 0;
    // During an active drag the canonical sceneVersion never bumps
    // (ephemeral delta only), so the normal cache key stays stable and no
    // recompile/redraw happens per frame. Drag compositing below reuses
    // the base image plus cached selection geometry.
    const key = buildRenderCacheKey(sceneVersion, camera, {
      width: cssWidth,
      height: cssHeight,
      dpr,
    });
    if (!hasDrag && progressDirty && prepared !== null) {
      // Progressive fill prepared geometry off-frame: fold it into the
      // prepared order (ids only, no recompile) and force the repaint
      // path below so new strokes appear in correct paint order.
      prepared = {
        version: prepared.version,
        items: withPendingStrokePreviews(
          sceneCache.update(model, registry, []),
        ),
        background: prepared.background,
      };
      progressDirty = false;
      lastProgressRepaint = Date.now();
      cacheKey = '';
    }
    if (!hasDrag && dragBase !== null) {
      // Drag ended/cancelled: hand the finished base to the pointer-up
      // path (a safe pure-translation commit promotes this completed drag
      // frame instead of repainting the document), then discard the live
      // layer. The committed `cache` below still holds the full scene
      // (drag frames never touch it), so a zero-move tap-select composites
      // correctly with zero rebuilds; a real commit bumps sceneVersion and
      // rebuilds once (via promotion when safe).
      finishedDrag = {
        base: dragBase,
        camera: lastDragCamera === null ? null : { ...lastDragCamera },
      };
      dragBase = null;
      lastDragCamera = null;
    }
    if (key !== cacheKey && !hasDrag) {
      cacheKey = key;
      rebuildCache(camera, sceneVersion, sizeChanged);
      paintedItems = prepared?.items ?? [];
      paintedBackground = prepared?.background ?? [];
      // Consume-or-drop: promotion either used the handoff above or found
      // it unsafe — it must never leak into a later, unrelated render.
      finishedDrag = null;
    } else if (!hasDrag) {
      finishedDrag = null;
    }

    if (viewBackend === null) return;
    const viewport = { width: cssWidth, height: cssHeight, dpr };
    const beginContentPass = (
      drawCamera: Camera,
      paperCamera: Camera = drawCamera,
    ): void => {
      viewBackend.begin(drawCamera, viewport);
      const frame = frameBounds(model.frame);
      if (frame !== null) {
        viewBackend.clipToFrame?.({
          x: drawCamera.x - paperCamera.x,
          y: drawCamera.y - paperCamera.y,
          width: frame.width,
          height: frame.height,
        });
      }
    };

    if (
      contentTranslation !== undefined &&
      contentTranslation !== null &&
      (contentTranslation.x !== 0 || contentTranslation.y !== 0)
    ) {
      const contentCamera: Camera = {
        x: camera.x - contentTranslation.x,
        y: camera.y - contentTranslation.y,
        zoom: camera.zoom,
      };
      viewBackend.clear(viewport);
      paintPaperAndBackground(camera, ctx);
      if (prepared !== null && prepared.background.length > 0) {
        dispatchScene(
          viewBackend,
          {
            frame: model.frame,
            items: [],
            backgroundItems: prepared.background,
          },
          camera,
          viewport,
        );
      }
      const frame = frameBounds(model.frame);
      viewBackend.begin(contentCamera, viewport);
      if (frame !== null) {
        viewBackend.clipToFrame?.({
          x: -contentTranslation.x,
          y: -contentTranslation.y,
          width: frame.width,
          height: frame.height,
        });
      }
      for (const item of prepared?.items ?? [])
        viewBackend.draw(item.item, item.transform);
      for (const item of previewItems) viewBackend.draw(item);
      viewBackend.end();
      paintOutline(camera, ctx);
      if (selectionBounds !== undefined && selectionBounds !== null) {
        drawSelectionChromeFromBounds(contentCamera, selectionBounds);
      } else {
        drawSelectionChrome(contentCamera, selection);
      }
      const readOnly = ports.isReadOnly?.() === true;
      if (ports.frameResizable && !readOnly) {
        paintResizeHandles(
          ctx,
          dpr,
          token,
          computePageViewRect(camera, frame),
          HANDLE_PX,
        );
      }
      if (!readOnly) drawObjectResizeHandle(contentCamera, selection);
      return;
    }

    if (hasDrag) {
      const dragState = drag as SelectionDragRenderState;
      // Canonical state may have advanced under an in-progress drag
      // (async image readiness, another committed gesture): refresh the
      // prepared scene first so the base splits post-commit positions —
      // never stale, never double-applied at pointer-up.
      if (prepared === null || prepared.version !== sceneVersion) {
        cacheKey = key;
        rebuildCache(camera, sceneVersion, sizeChanged);
        paintedItems = prepared?.items ?? [];
        paintedBackground = prepared?.background ?? [];
      }
      const dragIds = new Set(dragState.ids);
      const excludedKey =
        [...dragIds].sort().join(',') + '@v' + String(sceneVersion);
      const dragCameraChanged =
        lastDragCamera === null ||
        lastDragCamera.x !== camera.x ||
        lastDragCamera.y !== camera.y ||
        lastDragCamera.zoom !== camera.zoom;
      if (
        dragBase === null ||
        dragBase.excludedKey !== excludedKey ||
        dragBase.version !== sceneVersion ||
        sizeChanged ||
        dragCameraChanged
      ) {
        // One base rebuild per drag (not per frame): full scene WITHOUT
        // the moving selection, so translated copies leave no ghosts.
        // Highlighter safety: selection appears exactly once (here,
        // translated), never in the base.
        //
        // The moved selection must be a prepared part of the scene before
        // the base splits it out, or pointer-up promotion cannot resolve
        // the translated ids and falls back to a whole-document repaint
        // (the first-drag freeze in dense documents). Compile exactly the
        // selected logical units when missing — bounded by the selection.
        if (prepared !== null) {
          const dragKeys = sceneCache.preparationKeysFor(model, dragState.ids);
          if (dragKeys.some((key) => !sceneCache.isPrepared(key))) {
            sceneCache.prepareVisible(model, registry, dragState.ids);
            prepared = {
              version: prepared.version,
              items: withPendingStrokePreviews(
                sceneCache.update(model, registry, []),
              ),
              background: prepared.background,
            };
          }
        }
        const fullItems = prepared?.items ?? [];
        const baseItems = fullItems.filter((prepared) => {
          const oid = prepared.item.objectId;
          return !dragIds.has(oid);
        });
        const selectionItems = fullItems.filter((prepared) => {
          const oid = prepared.item.objectId;
          return dragIds.has(oid);
        });
        dragBase = {
          excludedKey,
          baseItems,
          selectionItems,
          version: sceneVersion,
        };
        lastDragCamera = { ...camera };
        // Paint the base WITHOUT the selection into the DEDICATED drag
        // canvas (once per drag/camera). The page outline is NOT part of
        // the base: it paints on top of the active drag frame (and once
        // during promotion), so a moved object can never cover it and it
        // is never painted twice. The committed `cache` keeps the full
        // scene untouched, so tap-selects and cancels need zero rebuilds
        // afterwards.
        if (dragCacheCtx !== null && dragCacheBackend !== null) {
          paintPaperAndBackground(camera, dragCacheCtx);
          dispatchScene(
            dragCacheBackend,
            {
              frame: model.frame,
              items: baseItems,
              backgroundItems: prepared?.background ?? [],
            },
            camera,
            viewport,
          );
          dragBaseRebuilds += 1;
          newlyDrawnCommittedItems += baseItems.length;
        }
      }
      // Per-frame drag composite (no recompile, no full redraw):
      // base image plus cached selection with an ephemeral camera shift.
      // Translating objects by (dx,dy) equals shifting the camera by
      // (-dx,-dy), so no per-sample copies are needed (renderer-neutral).
      viewBackend.clear(viewport);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(dragCache, 0, 0);
      const selectionCamera: Camera = {
        x: camera.x - dragState.dx,
        y: camera.y - dragState.dy,
        zoom: camera.zoom,
      };
      if (dragBase.selectionItems.length > 0) {
        beginContentPass(selectionCamera, camera);
        const following = new Set(
          dragState.followers?.map((item) => item.objectId),
        );
        for (const prepared of dragBase.selectionItems) {
          if (following.has(prepared.item.objectId)) continue;
          if (dragState.hidden !== true) {
            viewBackend.draw(prepared.item, prepared.transform);
          } else if (prepared.item.kind === 'card') {
            // Keep the card's fill and frame behind its live text editor.
            viewBackend.draw(
              { ...prepared.item, text: '' },
              prepared.transform,
            );
          }
        }
        viewBackend.end();
      }
      if (dragState.followers?.length) {
        beginContentPass(camera);
        for (const item of dragState.followers) viewBackend.draw(item);
        viewBackend.end();
      }
      // Page outline belongs to the active drag frame, ABOVE the moved
      // selection: a moved object can never visually cover it, and it is
      // painted exactly once (the drag base no longer carries it).
      paintOutline(camera, ctx);
      if (previewItems.length > 0 || selection.length > 0) {
        beginContentPass(camera);
        for (const item of previewItems) viewBackend.draw(item);
        if (
          dragState.translatedBounds !== undefined &&
          dragState.translatedBounds !== null
        ) {
          // Cheap chrome from cached translated union (Slice 10).
          // Painted here inside the already-begun overlay pass is not
          // possible (it uses raw ctx), so end, paint chrome, re-begin
          // only if more overlays remain (none after chrome here).
          viewBackend.end();
          drawSelectionChromeFromBounds(camera, dragState.translatedBounds);
          beginContentPass(camera);
        } else {
          drawSelectionChrome(camera, selection);
        }
        viewBackend.end();
      }
    } else {
      // Composite: one full-device clear, cached scene, then overlays
      // drawn WITHOUT clearing again — mid-stroke content stays visible.
      viewBackend.clear(viewport);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(cache, 0, 0);

      if (previewItems.length > 0 || selection.length > 0) {
        beginContentPass(camera);
        for (const item of previewItems) viewBackend.draw(item);
        // Cached union bounds (Slice 10) avoid rescanning every selected
        // stroke's samples on every idle render (pan frames with a large
        // selection); falls back to the envelope scan when absent.
        if (selectionBounds !== undefined && selectionBounds !== null) {
          viewBackend.end();
          drawSelectionChromeFromBounds(camera, selectionBounds);
        } else {
          drawSelectionChrome(camera, selection);
          viewBackend.end();
        }
      }
    }
    const readOnly = ports.isReadOnly?.() === true;
    if (ports.frameResizable && !readOnly) {
      paintResizeHandles(
        ctx,
        dpr,
        token,
        computePageViewRect(camera, frameBounds(model.frame)),
        HANDLE_PX,
      );
    }
    if (!readOnly) {
      const handleCamera =
        hasDrag && drag != null
          ? { ...camera, x: camera.x - drag.dx, y: camera.y - drag.dy }
          : camera;
      drawObjectResizeHandle(handleCamera, selection);
    }
    void drawResizeHandles;
  }

  return {
    syncSize,
    resize,
    render,
    notifyContentMutated,
    retainStrokePreviews,
    notifyTranslated,
    viewport: () => ({ width: pageWidth, height: pageHeight, dpr }),
    committedStats: () => ({
      fullCacheRebuilds,
      newlyDrawnCommittedItems,
      dragBaseRebuilds,
      dragPromotions,
      translationFullRepaints,
      committedItemsRepainted,
      progressPending: pendingOffscreen === null ? 0 : pendingOffscreen.length,
      progressPendingHead:
        pendingOffscreen === null ? [] : pendingOffscreen.slice(0, 8),
      priorityReorders,
      firstPaintVisible: firstPaintVisibleCount,
      firstPaintCost,
      firstPaintMs,
      scene: sceneCache.statsSnapshot(),
      cold: coldScheduler.statsSnapshot(),
    }),
    dispose: () => {
      disposed = true;
      // Detached notebook pages must release bitmap memory immediately;
      // waiting for GC can exhaust the WebView's canvas budget while paging.
      for (const buffer of [canvas, cache, dragCache]) {
        buffer.width = 0;
        buffer.height = 0;
      }
      if (repairCanvas !== null) {
        repairCanvas.width = 0;
        repairCanvas.height = 0;
      }
      repairCanvas = null;
      repairBackend = null;
      paintedItems = [];
      paintedBackground = [];
      pendingStrokePreviews.clear();
      coldScheduler.dispose();
    },
  };
}
