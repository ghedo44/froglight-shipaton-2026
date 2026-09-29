/**
 * Incremental prepared-scene cache (large-document freeze repair).
 *
 * `compileScene` recompiles every object on every mutation (O(total
 * samples) per new stroke). This cache compiles only new/changed object
 * IDs, removes deleted IDs, preserves unchanged compiled items, and
 * rebuilds paint-order references cheaply (O(ids), never O(samples)).
 *
 * Logical-stroke chunks are one invalidation unit: if any chunk of a
 * logical stroke changes, only that logical stroke recompiles (joint
 * B-spline fit over its chunks). Unchanged records reuse derived geometry
 * directly — no fingerprinting/rescanning of their samples to discover
 * that they are unchanged (that scan is exactly the freeze).
 */

import type {
  SurfaceModel,
  SurfaceObjectId,
  SurfaceObjectRecord,
  InkSample,
} from './model.js';
import { SURFACE_OBJECT_TYPES, chunkIndexOf, logicalIdOf } from './model.js';
import {
  groupLogicalChunks,
  type LogicalStrokeGroup,
} from './logical-stroke.js';
import {
  placeholderFor,
  estimatePrepareCost,
  isCompiledWarm,
  hasRichCompiledGeometry,
  packedCompiledForRecord,
  retainJointPackedForChunks,
  inkStrokeEnvelope,
  inkStrokeContoursOfRecord,
  jointInkSourceRecord,
  derivedTranslationOfRecord,
} from './objects.js';
import type { ColdInkCompileScheduler } from './ink/cold-scheduler.js';
import {
  packedRenderCounters,
  type PackedCompiledInk,
} from './ink/packed-protocol.js';
import type { InkBrushSpec } from './ink/brush.js';
import type { CompiledInkStroke } from './ink/compiler.js';
import type { SurfaceObjectTypeRegistry } from './registry.js';
import {
  preparedItem,
  preparedItems,
  type DrawItem,
  type PreparedItem,
} from './draw.js';

export interface IncrementalSceneStats {
  /** Recompiles of unchanged strokes (must stay 0 — never recompiled). */
  oldStrokeCompiles: number;
  /** Sample fingerprint scans of unchanged strokes (must stay 0 — never scanned). */
  oldStrokeFingerprintScans: number;
  /** Logical objects compiled in the last update (≈1 for a new stroke). */
  newlyCompiledObjects: number;
  /** Total cached logical objects. */
  cachedObjects: number;
  /** Full rebuilds (initial + unsafe fallbacks; 0 for simple appends). */
  fullRebuilds: number;
  /** Viewport prepares (lazy open / pan): visible-only compiles. */
  viewportPrepares: number;
  /** Progressive offscreen prepares (idle budget). */
  progressivePrepares: number;
  /** Logical-chunk regroups of the full model (must not grow per slice). */
  logicalRegroups: number;
  /** Prepared entries translated by rigid translation (no recompiles). */
  translatedKeys: number;
  /**
   * Prepared transform updates applied by rigid translation (O(moved
   * logical objects); never vertex copies — see `derivedTranslationStats`
   * for the cross-layer tripwire).
   */
  transformUpdates: number;
  /** Strokes deferred for cost (over budget, genuinely non-blocking). */
  deferredForCost: number;
}

function asItemList(
  compiled: DrawItem | readonly DrawItem[],
): readonly DrawItem[] {
  return Array.isArray(compiled)
    ? (compiled as readonly DrawItem[])
    : [compiled as DrawItem];
}

/**
 * Lazy compiled-geometry restore seam (dense-document reopen): consulted
 * exactly when an object enters preparation priority, so packed cache
 * entries stay packed until their object is actually about to be
 * prepared. Implementations install validated compiled geometry on the
 * record (or report a miss so the normal Worker path compiles it).
 *
 * Closure-pass packed rendering: sources may ALSO serve packed typed-array
 * geometry directly (`restorePacked`) so committed rendering never expands
 * `SerializedInkNode`/`Point` object graphs. `hasDurable` lets preparation
 * defer synchronous B-spline compiles while a durable entry is pending.
 */
export interface CompiledRestoreSource {
  /**
   * Attempt to restore compiled geometry for a stroke record entering
   * preparation. Returns true when geometry was installed. Never throws;
   * corruption is a miss.
   */
  restore(record: SurfaceObjectRecord): boolean;
  /**
   * Claim the packed payload WITHOUT unpacking (packed rendering path).
   * Returns the cache-owned packed value (do not detach buffers) or
   * undefined on miss. Never throws.
   */
  restorePacked?(
    record: SurfaceObjectRecord,
  ): import('./ink/packed-protocol.js').PackedCompiledInk | undefined;
  /**
   * True when a durable packed entry exists for the object (memory OR
   * manifest index). Preparation defers sync compiles while true-but-miss
   * so cached reopen never burns B-spline compiles on durable-held strokes.
   */
  hasDurable?(objectId: string): boolean;
}

function packedStrokeItemFor(
  record: SurfaceObjectRecord,
  packed: import('./ink/packed-protocol.js').PackedCompiledInk,
): import('./draw.js').PackedStrokeItem {
  const raw = record as Record<string, unknown>;
  const color =
    typeof raw['color'] === 'string' ? (raw['color'] as string) : undefined;
  const opacityRaw = raw['opacity'];
  const opacity = typeof opacityRaw === 'number' ? opacityRaw : undefined;
  const rotationRaw = raw['rotation'];
  const rotation =
    typeof rotationRaw === 'number' && Number.isFinite(rotationRaw)
      ? rotationRaw
      : 0;
  // Rotation uses the canonical source envelope in every representation.
  const bounds = inkStrokeEnvelope(record) ?? {
    x: packed.boundsXYWH[0]!,
    y: packed.boundsXYWH[1]!,
    width: packed.boundsXYWH[2]!,
    height: packed.boundsXYWH[3]!,
  };
  const { tx, ty } = derivedTranslationOfRecord(record);
  let contours: readonly (readonly { x: number; y: number }[])[] | undefined;
  if (record.erasure !== undefined) {
    contours = inkStrokeContoursOfRecord(record);
  }
  packedRenderCounters.packedDrawItemsCreated += 1;
  return {
    kind: 'packed-stroke',
    objectId: record.id,
    bounds,
    rotation,
    ...(color !== undefined ? { color } : {}),
    ...(opacity !== undefined ? { opacity } : {}),
    packed,
    ...(tx !== 0 || ty !== 0 ? { sourceOffset: { x: tx, y: ty } } : {}),
    ...(contours !== undefined ? { contours } : {}),
  };
}

function compileRecord(
  record: SurfaceObjectRecord,
  registry: SurfaceObjectTypeRegistry,
  restoreSource: CompiledRestoreSource | null = null,
): PreparedItem[] {
  // Retained packed-only reuse (packed-only correctness): a record that
  // carries retained packed geometry WITHOUT rich geometry (Worker/durable
  // packed render) reuses it directly — no restore, no unpack, no B-spline.
  // Records with rich geometry render rich (already materialized, no extra
  // unpack); interaction lazily materializes packed-only singles via
  // `materializeRichFromPacked` (one unpack, zero B-spline). Translation is
  // carried by the prepared transform, never by rewriting packed vertices.
  if (
    record.type === SURFACE_OBJECT_TYPES.stroke &&
    record.sourceId === undefined
  ) {
    try {
      const retained = packedCompiledForRecord(record);
      if (retained !== undefined) {
        // Packed-only (no rich): render packed directly.
        // Rich present: fall through to rich rendering below (which itself
        // reads packed outline without unpacking when beneficial).
        if (!hasRichCompiledGeometry(record)) {
          return preparedItems([packedStrokeItemFor(record, retained)]);
        }
      }
    } catch {
      // Retention probing never breaks preparation.
    }
  }
  // Packed rendering first (closure pass): cold Worker output and durable
  // cache hits stay in typed-array form — no `unpackCompiledInk`, no
  // B-spline compile for normal committed painting. Only objects actually
  // entering preparation priority consult the cache.
  if (
    restoreSource !== null &&
    record.type === SURFACE_OBJECT_TYPES.stroke &&
    record.sourceId === undefined &&
    !isCompiledWarm(record)
  ) {
    try {
      const packed = restoreSource.restorePacked?.(record);
      if (packed !== undefined) {
        return preparedItems([packedStrokeItemFor(record, packed)]);
      }
    } catch {
      // A throwing packed restore is a miss; fall through to rich restore.
    }
    try {
      restoreSource.restore(record);
    } catch {
      // A throwing restore is a miss; Worker compilation follows.
    }
    // Rich restore may have warmed the record; if it carries a retained
    // packed copy, prefer the packed item (no object-graph expansion for
    // painting) while keeping the rich geometry for hit-test/selection.
    // Note: `restore` already retained the packed copy on the record, so a
    // packed item here is still zero-unpack beyond the restore itself.
    // The packed path above is the true zero-unpack hit; this is a fallback
    // for sources without `restorePacked`.
  }
  const descriptor = registry.get(record.type);
  if (descriptor?.compile !== undefined) {
    try {
      const compiled = descriptor.compile(record);
      // Freshly compiled geometry is immutable local geometry with a zero
      // derived transform; translations accumulate on the wrapper later.
      if (compiled !== null) return preparedItems(asItemList(compiled));
    } catch {
      // Fall through to placeholder.
    }
  }
  return [preparedItem(placeholderFor(record))];
}

/** Key for the invalidation unit: logicalId for chunks, else objectId. */
function keyForRecord(record: SurfaceObjectRecord): string {
  const logical = logicalIdOf(record);
  return logical ?? record.id;
}

/**
 * Preparation priority ordering: paint order controls visual
 * stacking, but preparation order should serve the viewport first.
 * Returns unprepared ids in priority bands — visible viewport remainder,
 * then viewport prefetch margin, then the rest of the document — with
 * canonical paint order preserved WITHIN each band. Never mutates
 * `model.order`; callers store the result as their progressive queue.
 */
export function orderByPreparationPriority(
  modelOrder: readonly string[],
  isPrepared: (id: string) => boolean,
  visibleIds: ReadonlySet<string>,
  prefetchIds: ReadonlySet<string>,
): string[] {
  const visible: string[] = [];
  const prefetch: string[] = [];
  const rest: string[] = [];
  for (const id of modelOrder) {
    if (isPrepared(id)) continue;
    if (visibleIds.has(id)) visible.push(id);
    else if (prefetchIds.has(id)) prefetch.push(id);
    else rest.push(id);
  }
  return [...visible, ...prefetch, ...rest];
}

/**
 * Conservative compile throughput for cost budgeting (items 2–3): ~1000
 * canonical samples per millisecond on desktop. A 3ms slice therefore
 * budgets ~3000 samples synchronously; larger strokes defer to the async
 * worker/resumable path instead of blocking.
 */
export const PROGRESSIVE_SAMPLES_PER_MS = 1000;
/** First-paint synchronous cost budget (item 2): background always paints. */
export const FIRST_PAINT_MAX_COST = 3000;

export class IncrementalSceneCache {
  /**
   * Prepared entries by invalidation unit: immutable compiled geometry
   * plus a MUTABLE derived rigid translation per entry. A pure
   * translation only does `prepared.transform.tx += dx` on moved entries
   * (O(moved)), never maps/copies item points and never recompiles.
   */
  private readonly compiledByKey = new Map<string, PreparedItem[]>();
  /** chunkId → logical key (for deleted-chunk resolution). */
  private readonly chunkToKey = new Map<string, string>();
  /** logical key → chunkIds (for joint recompilation). */
  private readonly logicalMembers = new Map<string, Set<string>>();
  private lastOrder: string[] = [];
  /** Cached paint-order rank (id → position), built once, updated incrementally. */
  private readonly orderRank = new Map<string, number>();
  /** Cached logical groups (item 4): built once per open, updated incrementally. */
  private cachedGroups: Map<string, LogicalStrokeGroup> | null = null;
  private logicalDirty = true;
  /**
   * Cold-compile scheduler for huge deferred strokes: when set,
   * `prepareOneAsync` compiles through the worker-backed lane instead of
   * the main thread. Live writing never touches this (incremental path).
   */
  private coldScheduler: ColdInkCompileScheduler | null = null;
  /**
   * Lazy compiled-geometry restore seam: prepared objects consult it
   * before the registry compile, so cached packed vectors install only as
   * objects enter viewport/progressive preparation priority.
   */
  private restoreSource: CompiledRestoreSource | null = null;
  /**
   * Content generation: bumped on every content mutation
   * (`update` with mutations, `notifyTranslated`, `fullRebuild`,
   * `markLogicalDirty`). Order-only rebuilds never bump, so in-flight
   * cold compiles are not spuriously invalidated. Guards worker-result
   * installation in `prepareOneAsync` alongside record identity.
   */
  private modelGeneration = 0;
  private readonly stats: IncrementalSceneStats = {
    oldStrokeCompiles: 0,
    oldStrokeFingerprintScans: 0,
    newlyCompiledObjects: 0,
    cachedObjects: 0,
    fullRebuilds: 0,
    viewportPrepares: 0,
    progressivePrepares: 0,
    logicalRegroups: 0,
    translatedKeys: 0,
    transformUpdates: 0,
    deferredForCost: 0,
  };

  statsSnapshot(): IncrementalSceneStats {
    return { ...this.stats };
  }

  /**
   * Cached logical-chunk groups (item 4): built once per open, reused by
   * progressive slices without rescanning the full model. Mutations via
   * `update()`/`notifyTranslated()` refresh only affected logicals and
   * keep the cache valid; external bulk loads set `logicalDirty` via
   * `markLogicalDirty()`.
   */
  private ensureGroups(
    model: Pick<SurfaceModel, 'objects' | 'order'>,
  ): Map<string, LogicalStrokeGroup> {
    if (this.cachedGroups !== null && !this.logicalDirty)
      return this.cachedGroups;
    const groups = groupLogicalChunks(model);
    this.cachedGroups = groups;
    this.logicalDirty = false;
    this.stats.logicalRegroups += 1;
    // Refresh member maps incrementally (cheap id sets, no sample scans).
    // Preserve existing entries for unchanged logicals; rebuild sets here
    // only on regroup (once per open / dirty mutation, never per slice).
    for (const [logicalId, group] of groups) {
      this.logicalMembers.set(logicalId, new Set(group.chunkIds));
      for (const chunkId of group.chunkIds)
        this.chunkToKey.set(chunkId, logicalId);
    }
    return groups;
  }

  /** Mark the cached logical index dirty after external bulk mutations. */
  markLogicalDirty(): void {
    this.logicalDirty = true;
    this.modelGeneration += 1;
  }

  /**
   * Attach the worker-backed cold compiler. Null restores the
   * main-thread async path. Owned by the renderer; the cache never
   * constructs workers itself (headless, DOM-free).
   */
  setColdScheduler(scheduler: ColdInkCompileScheduler | null): void {
    this.coldScheduler = scheduler;
  }

  /**
   * Attach the lazy packed-cache restore source (dense-document reopen).
   * Null restores normal compilation only. The source is consulted
   * exclusively through `compileRecord`, i.e. only for objects entering
   * viewport/progressive preparation priority.
   */
  setCompiledRestoreSource(source: CompiledRestoreSource | null): void {
    this.restoreSource = source;
  }

  /** Current content generation (cold-compile staleness guard). */
  currentGeneration(): number {
    return this.modelGeneration;
  }

  /** Refresh cached paint-order ranks incrementally (ids only, no geometry). */
  private refreshOrderRank(model: Pick<SurfaceModel, 'order'>): void {
    this.orderRank.clear();
    for (let i = 0; i < model.order.length; i++) {
      this.orderRank.set(model.order[i]!, i);
    }
    this.lastOrder = [...model.order];
  }

  /**
   * Rigid translation in O(moved logical objects): bump the prepared
   * transform of cached entries for `ids` by `(dx,dy)` — pure metadata
   * mutation, zero geometry copies, zero recompiles. Logical chunks
   * resolve to their joint key (one translation per logical stroke).
   * Returns the number of cache keys translated.
   */
  notifyTranslated(
    ids: readonly SurfaceObjectId[],
    dx: number,
    dy: number,
  ): number {
    if (ids.length === 0 || (dx === 0 && dy === 0)) return 0;
    // Translated samples invalidate in-flight cold compiles for these ids
    // (their results predate the shift); shifted cached entries stay valid.
    this.coldScheduler?.cancelForObjects(ids);
    let translated = 0;
    const seen = new Set<string>();
    for (const id of ids) {
      const key = this.chunkToKey.get(id) ?? id;
      if (seen.has(key)) continue;
      seen.add(key);
      const items = this.compiledByKey.get(key);
      if (items === undefined) continue;
      // The O(1) translation: mutate the small transform record, never
      // the immutable geometry it annotates.
      for (const prepared of items) {
        prepared.transform.tx += dx;
        prepared.transform.ty += dy;
      }
      translated += 1;
    }
    this.stats.translatedKeys += translated;
    this.stats.transformUpdates += translated;
    if (translated > 0) this.modelGeneration += 1;
    return translated;
  }

  /** Full rebuild (initial paint + unsafe fallbacks). Counts as a rebuild, not old compiles. */
  fullRebuild(
    model: Pick<SurfaceModel, 'objects' | 'order'>,
    registry: SurfaceObjectTypeRegistry,
  ): readonly PreparedItem[] {
    this.compiledByKey.clear();
    this.chunkToKey.clear();
    this.logicalMembers.clear();
    this.modelGeneration += 1;
    // A full rebuild supersedes every in-flight cold compile.
    this.coldScheduler?.cancelForObjects(model.order);
    // Group once (O(ids), reads logicalId fields only — no sample scans
    // of unchanged strokes beyond their own compilation below, which is
    // unavoidable on first paint).
    const groups = groupLogicalChunks(model);
    this.cachedGroups = groups;
    this.logicalDirty = false;
    this.stats.logicalRegroups += 1;
    const chunkToLogical = new Map<string, string>();
    for (const [logicalId, group] of groups) {
      for (const chunkId of group.chunkIds)
        chunkToLogical.set(chunkId, logicalId);
      this.logicalMembers.set(logicalId, new Set(group.chunkIds));
    }
    let compiled = 0;
    const emitted = new Set<string>();
    const ordered: PreparedItem[] = [];
    // Compile each invalidation unit once, in first-seen paint order.
    for (const id of model.order) {
      const record = model.objects[id];
      if (record === undefined) continue;
      const logicalId = chunkToLogical.get(id);
      if (logicalId !== undefined) {
        if (emitted.has(logicalId)) continue;
        emitted.add(logicalId);
        const group = groups.get(logicalId)!;
        const joint = jointInkSourceRecord(group);
        const items = compileRecord(joint, registry, this.restoreSource);
        this.compiledByKey.set(logicalId, items);
        for (const chunkId of group.chunkIds)
          this.chunkToKey.set(chunkId, logicalId);
        ordered.push(...items);
        compiled += 1;
        continue;
      }
      const key = keyForRecord(record);
      if (emitted.has(key)) continue;
      emitted.add(key);
      const items = compileRecord(record, registry, this.restoreSource);
      this.compiledByKey.set(key, items);
      ordered.push(...items);
      compiled += 1;
    }
    this.lastOrder = [...model.order];
    this.refreshOrderRank(model);
    this.stats.newlyCompiledObjects = compiled;
    this.stats.cachedObjects = this.compiledByKey.size;
    this.stats.fullRebuilds += 1;
    return ordered;
  }

  /**
   * Viewport-only preparation (Slice 7): compile ONLY visible logical
   * objects (plus prefetch margin already included in visibleIds by the
   * caller via spatial-index query). Preserves canonical paint order for
   * the visible subset. Unchanged already-prepared items reuse geometry
   * without rescans. Never compiles offscreen strokes.
   */
  prepareVisible(
    model: Pick<SurfaceModel, 'objects' | 'order'>,
    registry: SurfaceObjectTypeRegistry,
    visibleIds: readonly string[],
  ): readonly PreparedItem[] {
    // Cached logical index (item 4): no full-model regroup per call.
    const groups = this.ensureGroups(model);
    if (this.orderRank.size !== model.order.length)
      this.refreshOrderRank(model);
    // Resolve visible invalidation keys (logical unit) via the cached
    // chunk map (no full-model scan).
    const visibleKeys = new Set<string>();
    for (const id of visibleIds) {
      const record = model.objects[id];
      if (record === undefined) continue;
      const logical = this.chunkToKey.get(id) ?? logicalIdOf(record) ?? id;
      const key = typeof logical === 'string' ? logical : id;
      visibleKeys.add(key);
    }
    const visibleIdSet = new Set(visibleIds);
    let compiled = 0;
    // Truly-lazy durable: collect durable-pending ids to preload (bounded
    // by the visible set itself) without synchronously compiling what the
    // durable cache already holds.
    const durablePending: string[] = [];
    for (const key of visibleKeys) {
      if (this.compiledByKey.has(key)) continue;
      // Compile this key only (bounded, reads only its own samples).
      const group = groups.get(key);
      if (group !== undefined) {
        // Cost-bounded first paint: giant logical joints never compile
        // synchronously on the viewport path (they hydrate via the async
        // Worker lane). Small joints compile inline; restore hits (packed)
        // are cheap and always render immediately.
        const jointCost = group.records.reduce(
          (sum, r) => sum + estimatePrepareCost(r),
          0,
        );
        // Durable joint pending: preload and defer (like singles below).
        try {
          const source = this.restoreSource as
            | (CompiledRestoreSource & {
                hasDurable?: (objectId: string) => boolean;
                hasMemoryPacked?: (objectId: string) => boolean;
                preload?: (objectIds: readonly string[]) => void;
              })
            | null;
          if (
            source?.hasDurable !== undefined &&
            !isCompiledWarm(group.records[0] as SurfaceObjectRecord)
          ) {
            // Joint id is the logical id (durable key); memory hits render
            // immediately via `compileRecord` below (packed, no defer).
            let memoryHit = false;
            try {
              memoryHit = source.hasMemoryPacked?.(group.logicalId) === true;
            } catch {
              memoryHit = false;
            }
            if (!memoryHit && source.hasDurable(group.logicalId)) {
              try {
                source.preload?.([group.logicalId]);
              } catch {
                // Preload never breaks paint.
              }
              durablePending.push(group.logicalId);
              continue;
            }
          }
        } catch {
          // Probing never breaks preparation.
        }
        if (jointCost > FIRST_PAINT_MAX_COST) {
          // Over-budget joint: leave unprepared for the async Worker lane
          // (`prepareOneAsync`); first paint stays cost-bounded.
          this.stats.deferredForCost += 1;
          continue;
        }
        const joint = jointInkSourceRecord(group);
        const items = compileRecord(joint, registry, this.restoreSource);
        // Retain restored joint packed on chunks for teardown persistence
        // (cache entry was taken; chunks hold it for the next persist).
        try {
          const first = items[0]?.item;
          if (
            first !== undefined &&
            (first as { kind?: unknown }).kind === 'packed-stroke'
          ) {
            const packed = (first as unknown as { packed: PackedCompiledInk })
              .packed;
            const chunks: SurfaceObjectRecord[] = [];
            for (const chunkId of group.chunkIds) {
              const chunk = (
                model as {
                  objects: Record<string, SurfaceObjectRecord | undefined>;
                }
              ).objects[chunkId];
              if (chunk !== undefined) chunks.push(chunk);
            }
            if (chunks.length > 0) {
              retainJointPackedForChunks(chunks, packed);
            }
          }
        } catch {
          // Retention never breaks preparation.
        }
        this.compiledByKey.set(key, items);
        for (const chunkId of group.chunkIds) this.chunkToKey.set(chunkId, key);
        compiled += 1;
        continue;
      }
      // Single record: find it (visibleIds are object ids; key is object id
      // for non-chunks, logical id for chunks already handled above).
      // Locate via the visible set (not a full scan, not a quadratic
      // includes() loop for large visible sets).
      let record: SurfaceObjectRecord | undefined;
      // Fast path: key itself is a visible object id.
      if (visibleIdSet.has(key)) {
        record = model.objects[key];
      } else {
        // Logical key whose chunks are visible: gather via groups (already
        // handled) or fallback scan limited to visible set.
        for (const vid of visibleIds) {
          const r = model.objects[vid];
          if (r !== undefined && (logicalIdOf(r) ?? r.id) === key) {
            // For non-chunked logicals this should not happen; compile the
            // first member as representative (bounded).
            record = r;
            break;
          }
        }
      }
      if (record === undefined) continue;
      // Defer synchronous B-spline compiles while a durable entry is pending
      // on disk (not yet in memory): trigger the bounded async load and leave
      // the key unprepared for a later slice (which will hit packed, no
      // compiles). Memory hits render immediately (packed, no defer).
      try {
        const source = this.restoreSource as
          | (CompiledRestoreSource & {
              hasDurable?: (objectId: string) => boolean;
              hasMemoryPacked?: (objectId: string) => boolean;
            })
          | null;
        if (
          source?.hasDurable !== undefined &&
          record.type === SURFACE_OBJECT_TYPES.stroke &&
          record.sourceId === undefined &&
          !isCompiledWarm(record)
        ) {
          const memoryHit = (() => {
            try {
              return source.hasMemoryPacked?.(record.id) === true;
            } catch {
              return false;
            }
          })();
          if (!memoryHit && source.hasDurable(record.id)) {
            durablePending.push(record.id);
            continue;
          }
        }
      } catch {
        // Durability probing never breaks preparation.
      }
      // Cost-bounded first paint: giant singles never compile synchronously
      // on the viewport path (they hydrate via the async Worker lane).
      // Restore hits (packed) are cheap and always render immediately via
      // `compileRecord` below; only genuine B-spline compiles defer.
      if (
        record.type === SURFACE_OBJECT_TYPES.stroke &&
        record.sourceId === undefined
      ) {
        try {
          // Peek restore without compiling: memory packed hit → render now.
          // Durable pending already deferred above; cold huge with no cache
          // defers here.
          if (!isCompiledWarm(record)) {
            const cost = estimatePrepareCost(record);
            if (cost > FIRST_PAINT_MAX_COST) {
              // Check for a cheap restore first (packed, no B-spline). If
              // `compileRecord` would hit restore, it is cheap; otherwise
              // defer the genuine huge compile to `prepareOneAsync`.
              // Heuristic: restore sources with `hasMemoryPacked` true mean
              // a cheap hit; otherwise assume a genuine compile and defer.
              let cheapRestore = false;
              try {
                const source = this.restoreSource as
                  | (CompiledRestoreSource & {
                      hasMemoryPacked?: (objectId: string) => boolean;
                    })
                  | null;
                cheapRestore = source?.hasMemoryPacked?.(record.id) === true;
              } catch {
                cheapRestore = false;
              }
              if (!cheapRestore) {
                this.stats.deferredForCost += 1;
                continue;
              }
            }
          }
        } catch {
          // Cost probing never breaks preparation.
        }
      }
      const items = compileRecord(record, registry, this.restoreSource);
      this.compiledByKey.set(key, items);
      compiled += 1;
    }
    // Bounded async preload for deferred durable entries (viewport priority
    // only — never the whole document). The next progressive slice or
    // invalidation will hit them (packed, no compiles).
    if (durablePending.length > 0) {
      try {
        const source = this.restoreSource as
          | (CompiledRestoreSource & {
              preload?: (objectIds: readonly string[]) => void;
            })
          | null;
        source?.preload?.(durablePending);
      } catch {
        // Preload never breaks paint.
      }
    }
    // Ordered visible items in canonical paint order without scanning
    // the full model (item 4): sort visible keys by cached rank (O(visible
    // log visible), ids only, no sample scans).
    const rankOf = (key: string): number => {
      const direct = this.orderRank.get(key);
      if (direct !== undefined) return direct;
      const group = groups.get(key);
      if (group !== undefined) {
        let best = Infinity;
        for (const chunkId of group.chunkIds) {
          const r = this.orderRank.get(chunkId);
          if (r !== undefined && r < best) best = r;
        }
        if (best !== Infinity) return best;
      }
      const members = this.logicalMembers.get(key);
      if (members !== undefined) {
        let best = Infinity;
        for (const chunkId of members) {
          const r = this.orderRank.get(chunkId);
          if (r !== undefined && r < best) best = r;
        }
        if (best !== Infinity) return best;
      }
      return Infinity;
    };
    const sortedKeys = [...visibleKeys].sort((a, b) => rankOf(a) - rankOf(b));
    const ordered: PreparedItem[] = [];
    for (const key of sortedKeys) {
      const items = this.compiledByKey.get(key);
      if (items !== undefined) ordered.push(...items);
    }
    this.lastOrder = [...model.order];
    this.stats.newlyCompiledObjects = compiled;
    this.stats.cachedObjects = this.compiledByKey.size;
    this.stats.viewportPrepares += 1;
    return ordered;
  }

  /**
   * Progressive offscreen preparation (Slice 8, repaired item 3): compile
   * remaining ids in bounded COST chunks, never monopolizing the main
   * thread. The old wall-clock-only check compiled a huge stroke first and
   * measured afterwards (fake 3ms budget). Now estimated geometry cost is
   * checked BEFORE each compile: a single stroke exceeding the slice budget
   * is deferred untouched (counted, returned in `remaining` for the async
   * worker/resumable path) instead of blocking for hundreds of ms.
   */
  prepareMore(
    model: Pick<SurfaceModel, 'objects' | 'order'>,
    registry: SurfaceObjectTypeRegistry,
    pendingIds: readonly string[],
    budgetMs = 3,
  ): { compiled: number; remaining: readonly string[] } {
    const perf = (globalThis as unknown as { performance?: { now(): number } })
      .performance;
    const start =
      perf !== undefined && typeof perf.now === 'function'
        ? perf.now()
        : Date.now();
    let compiled = 0;
    let i = 0;
    // Cached logical index (item 4): no full-model regroup per slice.
    const groups = this.ensureGroups(model);
    // Cost budget: ~1000 samples per ms (conservative desktop estimate).
    // A 50k-sample stroke (≈50ms) never compiles synchronously in a 3ms
    // slice — it defers to the async path (item 3).
    const maxCost = Math.max(
      1,
      Math.floor(budgetMs * PROGRESSIVE_SAMPLES_PER_MS),
    );
    let spentCost = 0;
    const deferred: string[] = [];
    // Prepare in paint order for deterministic prefetch (visible first is
    // already cached; remaining are offscreen in order).
    for (; i < pendingIds.length; i++) {
      const id = pendingIds[i] as string;
      const record = model.objects[id];
      if (record === undefined) continue;
      const key = this.chunkToKey.get(id) ?? keyForRecord(record);
      if (this.compiledByKey.has(key)) continue;
      // Logical groups compile jointly once (bounded).
      const logical = this.chunkToKey.get(id) ?? logicalIdOf(record);
      const resolvedKey =
        typeof logical === 'string' && groups.has(logical) ? logical : key;
      if (this.compiledByKey.has(resolvedKey)) continue;
      const group =
        typeof resolvedKey === 'string' ? groups.get(resolvedKey) : undefined;
      // Truly-lazy durable: skip synchronous work for disk-pending entries
      // (leave for the async lane which awaits ONE entry, bounded). Memory
      // hits still render immediately via `compileRecord`'s packed path.
      // Logical joints ARE durably persisted under their logical id (FINAL
      // §5): use the same cache priority as visible preparation —
      // in-memory packed hit renders now, durable entry preloads ONE logical
      // entry and defers sync compilation, otherwise cost policy decides.
      if (group !== undefined) {
        try {
          const source = this.restoreSource as
            | (CompiledRestoreSource & {
                hasDurable?: (objectId: string) => boolean;
                hasMemoryPacked?: (objectId: string) => boolean;
                preload?: (objectIds: readonly string[]) => void;
              })
            | null;
          if (
            source?.hasDurable !== undefined &&
            !isCompiledWarm(group.records[0] as SurfaceObjectRecord)
          ) {
            let memoryHit = false;
            try {
              memoryHit = source.hasMemoryPacked?.(group.logicalId) === true;
            } catch {
              memoryHit = false;
            }
            if (!memoryHit && source.hasDurable(group.logicalId)) {
              try {
                source.preload?.([group.logicalId]);
              } catch {
                // Preload never breaks progressive.
              }
              deferred.push(id);
              continue;
            }
          }
        } catch {
          // Probing never breaks progressive.
        }
      }
      if (
        group === undefined &&
        record.type === SURFACE_OBJECT_TYPES.stroke &&
        record.sourceId === undefined
      ) {
        try {
          const source = this.restoreSource as
            | (CompiledRestoreSource & {
                hasDurable?: (objectId: string) => boolean;
                hasMemoryPacked?: (objectId: string) => boolean;
                preload?: (objectIds: readonly string[]) => void;
              })
            | null;
          if (source?.hasDurable !== undefined && !isCompiledWarm(record)) {
            const memoryHit = (() => {
              try {
                return source.hasMemoryPacked?.(record.id) === true;
              } catch {
                return false;
              }
            })();
            if (!memoryHit && source.hasDurable(record.id)) {
              try {
                source.preload?.([record.id]);
              } catch {
                // Preload never breaks progressive.
              }
              deferred.push(id);
              continue;
            }
          }
        } catch {
          // Probing never breaks progressive.
        }
      }
      const cost =
        group !== undefined
          ? group.records.reduce((sum, r) => sum + estimatePrepareCost(r), 0)
          : estimatePrepareCost(record);
      // Genuine budget (item 3): defer over-budget strokes BEFORE compiling.
      if (cost > maxCost - spentCost) {
        // Over-budget head defers untouched so a huge stroke cannot
        // synchronously monopolize the thread; later small items in the
        // same slice may still compile (order preserved via `deferred`).
        deferred.push(id);
        this.stats.deferredForCost += 1;
        continue;
      }
      if (group !== undefined) {
        const joint = jointInkSourceRecord(group);
        const items = compileRecord(joint, registry, this.restoreSource);
        // Retain restored joint packed on chunks for teardown persistence
        // (same as viewport path; cache entry was taken).
        try {
          const first = items[0]?.item;
          if (
            first !== undefined &&
            (first as { kind?: unknown }).kind === 'packed-stroke'
          ) {
            const packed = (first as unknown as { packed: PackedCompiledInk })
              .packed;
            const chunks: SurfaceObjectRecord[] = [];
            for (const chunkId of group.chunkIds) {
              const chunk = (
                model as {
                  objects: Record<string, SurfaceObjectRecord | undefined>;
                }
              ).objects[chunkId];
              if (chunk !== undefined) chunks.push(chunk);
            }
            if (chunks.length > 0) {
              retainJointPackedForChunks(chunks, packed);
            }
          }
        } catch {
          // Retention never breaks preparation.
        }
        this.compiledByKey.set(resolvedKey, items);
        for (const chunkId of group.chunkIds)
          this.chunkToKey.set(chunkId, resolvedKey);
        this.logicalMembers.set(resolvedKey, new Set(group.chunkIds));
        compiled += 1;
        spentCost += cost;
      } else {
        const items = compileRecord(record, registry, this.restoreSource);
        this.compiledByKey.set(resolvedKey, items);
        compiled += 1;
        spentCost += cost;
      }
      const now =
        perf !== undefined && typeof perf.now === 'function'
          ? perf.now()
          : Date.now();
      if (now - start >= budgetMs) {
        i += 1;
        break;
      }
    }
    this.stats.cachedObjects = this.compiledByKey.size;
    this.stats.progressivePrepares += 1;
    // newlyCompiledObjects reflects the last progressive slice (bounded).
    this.stats.newlyCompiledObjects = compiled;
    // Remaining: unvisited tail plus deferred over-budget heads (async
    // path, order-preserved, never dropped).
    const visitedTail = pendingIds.slice(
      i >= pendingIds.length ? pendingIds.length : i,
    );
    const remaining =
      deferred.length > 0
        ? [
            ...deferred,
            ...visitedTail.filter((id) => !deferred.includes(id as string)),
          ]
        : visitedTail;
    return { compiled, remaining };
  }

  /** True when the key is already prepared (no recompile needed). */
  isPrepared(key: string): boolean {
    return this.compiledByKey.has(key);
  }

  /**
   * Invalidation keys for object ids in order: logical-chunk
   * ids resolve to their joint key, others to themselves; deduplicated,
   * order-preserving. Lets the cold scheduler reorder its queue in the
   * same priority bands as the progressive queue (keys, not object ids).
   */
  preparationKeysFor(
    model: Pick<SurfaceModel, 'objects' | 'order'>,
    ids: readonly string[],
  ): string[] {
    const groups = this.ensureGroups(model);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const record = model.objects[id];
      const logical =
        record === undefined
          ? this.chunkToKey.get(id)
          : (this.chunkToKey.get(id) ?? logicalIdOf(record));
      const key =
        typeof logical === 'string' && groups.has(logical)
          ? logical
          : record !== undefined
            ? keyForRecord(record)
            : id;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
    return out;
  }

  /**
   * Async hydration for deferred huge strokes (item 3): compile
   * one id through the attached worker-backed cold scheduler when present
   * (genuinely off-thread), else the resumable main-thread async compiler
   * (yields between phases). Warms the per-record compiled cache, then
   * builds DrawItems through the normal sync path (cache hit, no
   * recompile). Returns true when the key is now prepared. Identical
   * geometry to sync in both lanes.
   *
   * Staleness: the compile captures the content generation and the exact
   * record identities; a result that arrives after a newer mutation is
   * discarded, never installed (scheduler generations + local guards).
   */
  async prepareOneAsync(
    model: Pick<SurfaceModel, 'objects' | 'order'>,
    registry: SurfaceObjectTypeRegistry,
    id: string,
  ): Promise<boolean> {
    const record = model.objects[id];
    if (record === undefined) return false;
    const groups = this.ensureGroups(model);
    const logical = this.chunkToKey.get(id) ?? logicalIdOf(record);
    const key =
      typeof logical === 'string' && groups.has(logical)
        ? logical
        : keyForRecord(record);
    if (this.compiledByKey.has(key)) return true;
    const group = typeof key === 'string' ? groups.get(key) : undefined;
    try {
      const { compileInkStrokeAsync } = await import('./ink/async-compiler.js');
      const {
        inkTypedSamplesOf,
        setCompiledForRecord,
        retainPackedOnlyForRecord,
      } = await import('./objects.js');
      if (group !== undefined) {
        // Joint logical compile: async fit over concatenated samples, then
        // warm each chunk's cache? Joint record is ephemeral — warm by
        // compiling joint async and building items directly (no per-chunk
        // cache needed; scene cache holds the joint DrawItems).
        const { logicalHead: headOf, logicalSamples: samplesOf } = await import(
          './logical-stroke.js'
        );
        const joint: SurfaceObjectRecord = {
          ...headOf(group),
          id: group.logicalId,
          points: samplesOf(group),
        };
        // Warm via cold lane for Ink joints (same brush resolution as sync).
        const jointType = (joint as { type?: unknown }).type;
        if (jointType === 'froglight.ink.stroke') {
          const { inkTypedSamplesOf: typedOf, resolveStrokeBrush: brushOf } =
            await import('./objects.js');
          // Packed cache first (no unpack, no Worker): memory hits render
          // directly as packed items. Durable-disk pending awaits ONE entry
          // load (viewport priority, bounded) before the Worker lane.
          if (this.restoreSource !== null && !isCompiledWarm(joint)) {
            const packedHit = this.#tryRestorePacked(this.restoreSource, joint);
            if (packedHit !== undefined) {
              // Restored joint: retain on chunks for future persistence
              // (cache entry was taken, so chunks hold it for teardown).
              try {
                const { retainJointPackedForChunks } = await import(
                  './objects.js'
                );
                const chunks: SurfaceObjectRecord[] = [];
                for (const chunkId of group.chunkIds) {
                  const chunk = model.objects[chunkId];
                  if (chunk !== undefined) chunks.push(chunk);
                }
                if (chunks.length > 0) {
                  retainJointPackedForChunks(chunks, packedHit);
                }
              } catch {
                // Retention never breaks preparation.
              }
              const items = preparedItems([
                packedStrokeItemFor(joint, packedHit),
              ]);
              this.compiledByKey.set(key, items);
              for (const chunkId of group.chunkIds)
                this.chunkToKey.set(chunkId, key);
              this.logicalMembers.set(key, new Set(group.chunkIds));
              this.stats.cachedObjects = this.compiledByKey.size;
              return true;
            }
            const durableSource = this
              .restoreSource as CompiledRestoreSource & {
              hasDurable?: (objectId: string) => boolean;
              hasMemoryPacked?: (objectId: string) => boolean;
              loadPackedEntry?: (
                objectId: string,
              ) => Promise<PackedCompiledInk | null>;
            };
            try {
              const memoryHit =
                durableSource.hasMemoryPacked?.(joint.id) === true;
              if (!memoryHit && durableSource.hasDurable?.(joint.id) === true) {
                const loaded = await durableSource.loadPackedEntry?.(joint.id);
                if (loaded !== undefined && loaded !== null) {
                  // Count the restore (take from memory, retain packed-only)
                  // so diagnostics prove cached vs compiled.
                  const counted =
                    this.#tryRestorePacked(this.restoreSource, joint) ?? loaded;
                  try {
                    retainPackedOnlyForRecord(joint, counted);
                    // Retain joint on chunks for teardown persistence.
                    const { retainJointPackedForChunks } = await import(
                      './objects.js'
                    );
                    const chunks: SurfaceObjectRecord[] = [];
                    for (const chunkId of group.chunkIds) {
                      const chunk = model.objects[chunkId];
                      if (chunk !== undefined) chunks.push(chunk);
                    }
                    if (chunks.length > 0) {
                      retainJointPackedForChunks(chunks, counted);
                    }
                  } catch {
                    // Retention never breaks preparation.
                  }
                  const items = preparedItems([
                    packedStrokeItemFor(joint, counted),
                  ]);
                  this.compiledByKey.set(key, items);
                  for (const chunkId of group.chunkIds)
                    this.chunkToKey.set(chunkId, key);
                  this.logicalMembers.set(key, new Set(group.chunkIds));
                  this.stats.cachedObjects = this.compiledByKey.size;
                  return true;
                }
              }
            } catch {
              // Durable await never breaks the Worker fallback.
            }
          }
          const samples = typedOf(joint);
          const restoredFromCache =
            this.restoreSource !== null &&
            !isCompiledWarm(joint) &&
            this.#tryRestore(this.restoreSource, joint);
          if (!restoredFromCache && samples.length > 0) {
            const brush = brushOf(joint);
            const chunkRefs = group.chunkIds.map(
              (chunkId) => model.objects[chunkId],
            );
            const result = await this.coldCompileInk(
              key,
              samples,
              brush,
              compileInkStrokeAsync,
              () =>
                group.chunkIds.every(
                  (chunkId, index) =>
                    model.objects[chunkId] === chunkRefs[index],
                ),
            );
            if (result === null) return false;
            // Packed-direct Worker results (no unpack, no rich): retain the
            // joint packed on every chunk (same reference, no duplication)
            // so teardown persists one stable joint entry under the logical
            // id. Render packed directly.
            if (result.packed !== undefined && result.compiled === undefined) {
              try {
                const chunks: SurfaceObjectRecord[] = [];
                for (const chunkId of group.chunkIds) {
                  const chunk = model.objects[chunkId];
                  if (chunk !== undefined) chunks.push(chunk);
                }
                if (chunks.length > 0) {
                  retainJointPackedForChunks(chunks, result.packed);
                }
              } catch {
                // Retention never breaks preparation.
              }
              const items = preparedItems([
                packedStrokeItemFor(joint, result.packed),
              ]);
              this.compiledByKey.set(key, items);
              for (const chunkId of group.chunkIds)
                this.chunkToKey.set(chunkId, key);
              this.logicalMembers.set(key, new Set(group.chunkIds));
              this.stats.cachedObjects = this.compiledByKey.size;
              return true;
            }
            setCompiledForRecord(
              joint as SurfaceObjectRecord,
              result.compiled ?? null,
              result.packed,
            );
          }
        }
        const items = compileRecord(joint, registry, this.restoreSource);
        this.compiledByKey.set(key, items);
        for (const chunkId of group.chunkIds) this.chunkToKey.set(chunkId, key);
        this.logicalMembers.set(key, new Set(group.chunkIds));
        this.stats.cachedObjects = this.compiledByKey.size;
        return true;
      }
      // Single record: packed cache first (no unpack), then durable await,
      // then cold-lane Worker (packed-direct), then sync DrawItems.
      if ((record as { type?: unknown }).type === 'froglight.ink.stroke') {
        if (this.restoreSource !== null && !isCompiledWarm(record)) {
          const packedHit = this.#tryRestorePacked(this.restoreSource, record);
          if (packedHit !== undefined) {
            const items = preparedItems([
              packedStrokeItemFor(record, packedHit),
            ]);
            this.compiledByKey.set(key, items);
            this.stats.cachedObjects = this.compiledByKey.size;
            return true;
          }
          const durableSource = this.restoreSource as CompiledRestoreSource & {
            hasDurable?: (objectId: string) => boolean;
            hasMemoryPacked?: (objectId: string) => boolean;
            loadPackedEntry?: (
              objectId: string,
            ) => Promise<PackedCompiledInk | null>;
          };
          try {
            const memoryHit =
              durableSource.hasMemoryPacked?.(record.id) === true;
            if (!memoryHit && durableSource.hasDurable?.(record.id) === true) {
              const loaded = await durableSource.loadPackedEntry?.(record.id);
              if (loaded !== undefined && loaded !== null) {
                // Count the restore (take from memory, retain packed-only) so
                // diagnostics prove cached vs compiled.
                const counted =
                  this.#tryRestorePacked(this.restoreSource, record) ?? loaded;
                try {
                  retainPackedOnlyForRecord(record, counted);
                } catch {
                  // Retention never breaks preparation.
                }
                const items = preparedItems([
                  packedStrokeItemFor(record, counted),
                ]);
                this.compiledByKey.set(key, items);
                this.stats.cachedObjects = this.compiledByKey.size;
                return true;
              }
            }
          } catch {
            // Durable await never breaks the Worker fallback.
          }
        }
        const restoredFromCache =
          this.restoreSource !== null &&
          !isCompiledWarm(record) &&
          this.#tryRestore(this.restoreSource, record);
        if (!restoredFromCache) {
          const samples = inkTypedSamplesOf(record);
          if (samples.length > 0) {
            const { resolveStrokeBrush } = await import('./objects.js');
            const brush = resolveStrokeBrush(record);
            const result = await this.coldCompileInk(
              key,
              samples,
              brush,
              compileInkStrokeAsync,
              () => model.objects[id] === record,
            );
            if (result === null) return false;
            if (result.packed !== undefined && result.compiled === undefined) {
              // Packed-direct Worker (no unpack, no rich): retain packed-only
              // for persistence, render packed directly.
              try {
                retainPackedOnlyForRecord(record, result.packed);
              } catch {
                // Retention never breaks preparation.
              }
              const items = preparedItems([
                packedStrokeItemFor(record, result.packed),
              ]);
              this.compiledByKey.set(key, items);
              this.stats.cachedObjects = this.compiledByKey.size;
              return true;
            }
            setCompiledForRecord(
              record,
              result.compiled ?? null,
              result.packed,
            );
            // Fallback rich compile (main-thread async, no Worker): retain a
            // packed copy immediately on the async lane (not teardown) so a
            // later teardown persists without sync packing. Best-effort.
            if (result.compiled !== undefined && result.packed === undefined) {
              try {
                const { packCompiledInk } = await import(
                  './ink/packed-protocol.js'
                );
                const { retainPackedForRecord } = await import('./objects.js');
                retainPackedForRecord(
                  record,
                  packCompiledInk(result.compiled).packed,
                );
              } catch {
                // Background retention never breaks preparation.
              }
            }
          }
        } else {
          // Rich restore hit (legacy sources without `restorePacked`):
          // compileRecord below will hit warm (no recompile). Packed restores
          // above already returned (packed-direct, no unpack).
        }
      }
      const items = compileRecord(record, registry, this.restoreSource);
      this.compiledByKey.set(key, items);
      this.stats.cachedObjects = this.compiledByKey.size;
      return true;
    } catch {
      return false;
    }
  }

  /** Restore attempt that never throws (safe cache miss on corruption). */
  #tryRestore(
    source: CompiledRestoreSource,
    record: SurfaceObjectRecord,
  ): boolean {
    try {
      // Packed first (no unpack, no B-spline for painting); rich fallback
      // for sources without `restorePacked`.
      const packed = source.restorePacked?.(record);
      if (packed !== undefined) return true;
      return source.restore(record);
    } catch {
      return false;
    }
  }

  /** Packed-only restore attempt (no unpack, no rich install). */
  #tryRestorePacked(
    source: CompiledRestoreSource,
    record: SurfaceObjectRecord,
  ): import('./ink/packed-protocol.js').PackedCompiledInk | undefined {
    try {
      return source.restorePacked?.(record);
    } catch {
      return undefined;
    }
  }

  /**
   * One Ink compile through the cold lane: worker-backed when
   * a scheduler is attached, else the resumable main-thread async
   * compiler. `isCurrent` revalidates record identity after the await;
   * generation drift discards the result. Returns null when nothing may
   * be installed (stale or failed). Worker results are packed-direct (no
   * unpack, no rich); fallback results are rich (background packing retains
   * packed later).
   */
  private async coldCompileInk(
    jobObjectId: string,
    samples: readonly InkSample[],
    brush: InkBrushSpec,
    fallback: (
      samples: readonly InkSample[],
      brush: InkBrushSpec,
    ) => Promise<CompiledInkStroke>,
    isCurrent: () => boolean,
  ): Promise<{
    readonly compiled: CompiledInkStroke | undefined;
    readonly packed: PackedCompiledInk | undefined;
  } | null> {
    const scheduler = this.coldScheduler;
    if (scheduler === null) {
      const compiled = await fallback(samples, brush);
      return isCurrent() ? { compiled, packed: undefined } : null;
    }
    const generation = this.modelGeneration;
    const result = await scheduler.compile({
      objectId: jobObjectId,
      generation,
      samples,
      brush,
    });
    if (result.status !== 'ready') return null;
    if (generation !== this.modelGeneration || !isCurrent()) return null;
    return { compiled: result.compiled, packed: result.packed };
  }

  /**
   * Incremental update: compile only new/changed keys, remove deleted,
   * preserve unchanged items, rebuild paint order cheaply (ids only).
   * `contentMutatedIds` are object ids whose RECORD content changed
   * (from the mutation recorder); pure order/frame changes pass [] and
   * only rebuild order references.
   */
  update(
    model: Pick<SurfaceModel, 'objects' | 'order'>,
    registry: SurfaceObjectTypeRegistry,
    contentMutatedIds: readonly SurfaceObjectId[],
    maxSyncInkSamples = Infinity,
  ): readonly PreparedItem[] {
    if (
      maxSyncInkSamples === Infinity &&
      this.compiledByKey.size === 0 &&
      this.lastOrder.length === 0
    ) {
      return this.fullRebuild(model, registry);
    }
    // Mutation paints obey the same cold-compile bound as first paint.
    // Empty placeholders are removed before returning so progressive work
    // still sees these keys as unprepared (never as an empty stroke).
    const deferred = new Set<string>();
    const compileUpdated = (record: SurfaceObjectRecord): PreparedItem[] => {
      if (
        estimatePrepareCost(record) > maxSyncInkSamples &&
        !isCompiledWarm(record)
      ) {
        deferred.add(record.id);
        this.stats.deferredForCost += 1;
        return [];
      }
      return compileRecord(record, registry, this.restoreSource);
    };
    // Content changed: invalidate in-flight cold compiles (order-only
    // rebuilds pass [] and must NOT bump — progressive folding calls
    // update([]) after every slice).
    if (contentMutatedIds.length > 0) {
      this.modelGeneration += 1;
      // Free the cold lane promptly: compiles enqueued for these ids are
      // stale (their samples changed). Already-installed geometry is
      // refreshed below through the normal paths.
      this.coldScheduler?.cancelForObjects(contentMutatedIds);
    }
    // Resolve affected invalidation keys (logical unit).
    //
    // Membership-change rule: every mutated id resolves BOTH the previous
    // prepared key (old ownership, via chunkToKey) AND the current canonical
    // key (new ownership, via logicalIdOf / record id) BEFORE cached
    // ownership mutates below. A logical→logical move (B:L→M) therefore
    // invalidates L (stale survivor) and M (new member) together; chunkToKey
    // is only the old-ownership witness here, never trusted beyond this
    // resolution — every structure below reconciles to current canonical
    // membership.
    const affected = new Set<string>();
    for (const id of contentMutatedIds) {
      const previousKey = this.chunkToKey.get(id);
      if (previousKey !== undefined) affected.add(previousKey);
      const record = model.objects[id];
      if (record === undefined) continue; // Deleted: previous key alone.
      const currentLogical = logicalIdOf(record);
      if (currentLogical !== null) affected.add(currentLogical);
      else affected.add(id);
    }
    let recompiled = 0;
    for (const key of affected) {
      // Is this key a logical group (current or previous)?
      const members = this.logicalMembers.get(key);
      if (members !== undefined) {
        // Logical group: gather CURRENT canonical chunks for this logical by
        // scanning the SMALL member set (not the whole model) plus any
        // new chunks that claim this logical (from mutated ids). Cached
        // members that no longer canonically belong here (departed B:L→M,
        // detached to single, deleted) are excluded — they recompile via
        // their own affected key.
        const currentChunkIds = new Set<string>();
        for (const memberId of members) {
          const memberRecord = model.objects[memberId];
          if (memberRecord === undefined) continue;
          if (logicalIdOf(memberRecord) === key) currentChunkIds.add(memberId);
        }
        // New chunks for this logical that were not in the old member set
        // (e.g., a long stroke appending a second chunk — rare, but handle
        // via mutated ids claiming this logical).
        for (const id of contentMutatedIds) {
          const rec = model.objects[id];
          if (rec !== undefined && logicalIdOf(rec) === key)
            currentChunkIds.add(id);
        }
        if (currentChunkIds.size === 0) {
          // Whole logical deleted.
          this.compiledByKey.delete(key);
          this.logicalMembers.delete(key);
          for (const chunkId of members) {
            // Guarded by current ownership so a swapped chunk (B:L→M while
            // D:M→L in one batch) never loses its new mapping regardless of
            // affected processing order.
            if (this.chunkToKey.get(chunkId) === key)
              this.chunkToKey.delete(chunkId);
          }
          continue;
        }
        // Recompile jointly (reads ONLY this logical's samples).
        const records: SurfaceObjectRecord[] = [];
        for (const chunkId of currentChunkIds) {
          const rec = model.objects[chunkId];
          if (rec !== undefined) records.push(rec);
        }
        records.sort((a, b) => {
          const ai = chunkIndexOf(a) ?? 0;
          const bi = chunkIndexOf(b) ?? 0;
          return ai - bi;
        });
        const head = records[0]!;
        const joint: SurfaceObjectRecord = {
          ...head,
          id: key,
          points: records.flatMap((r) => {
            const pts = (r as Record<string, unknown>).points;
            return Array.isArray(pts) ? (pts as never[]) : [];
          }) as never,
        };
        const items = compileUpdated(joint);
        this.compiledByKey.set(key, items);
        // Refresh membership.
        this.logicalMembers.set(key, currentChunkIds);
        for (const chunkId of currentChunkIds)
          this.chunkToKey.set(chunkId, key);
        // Remove stale chunk mappings for chunks no longer in the group.
        // Guarded by current ownership (see above): the moved chunk's new
        // mapping survives no matter which affected key processes first.
        for (const oldChunk of members) {
          if (
            !currentChunkIds.has(oldChunk) &&
            this.chunkToKey.get(oldChunk) === key
          )
            this.chunkToKey.delete(oldChunk);
        }
        recompiled += 1;
        continue;
      }
      // Non-logical key: single record.
      const record = model.objects[key];
      if (record === undefined) {
        // Deleted (or never existed): drop cache entry, drop chunk mapping.
        this.compiledByKey.delete(key);
        this.chunkToKey.delete(key);
        continue;
      }
      // Check if this id is actually a chunk of a logical we track under
      // a different key (e.g., new chunk appended to an existing logical
      // where mutated id is the chunk, not the logical). Resolve via
      // current logical first.
      const currentLogical = logicalIdOf(record);
      if (currentLogical !== null && currentLogical !== key) {
        // Redirect to the logical path (recompile the whole group once).
        if (!affected.has(currentLogical)) {
          affected.add(currentLogical);
          // Defer: handle in a second pass by re-queueing. Since Sets
          // iterate insertion order, adding during iteration is visited.
          continue;
        }
        continue;
      }
      const items = compileUpdated(record);
      this.compiledByKey.set(key, items);
      recompiled += 1;
    }
    // Rebuild paint-order references cheaply (ids only, no geometry).
    // Logical chunks emit once at the head's first paint position.
    const ordered: PreparedItem[] = [];
    const emitted = new Set<string>();
    for (const id of model.order) {
      const record = model.objects[id];
      if (record === undefined) continue;
      const logical = logicalIdOf(record);
      if (logical !== null) {
        if (emitted.has(logical)) continue;
        emitted.add(logical);
        const items = this.compiledByKey.get(logical);
        if (items !== undefined) ordered.push(...items);
        else if (affected.has(logical)) {
          // Cache miss for an actually-mutated key (e.g., undo restored a
          // logical we evicted): compile just this group (bounded, not a
          // full rebuild). Misses for merely-unprepared keys (lazy open)
          // are skipped here — viewport/progressive paths prepare them
          // explicitly, so order-only rebuilds never mass-compile
          // offscreen geometry.
          const groupMembers: SurfaceObjectRecord[] = [];
          // Siblings via the cached index + mutated set (item 4, no model
          // scan): cached members first, then mutated ids claiming this
          // logical (undo restores).
          const cachedMembers = this.logicalMembers.get(logical);
          if (cachedMembers !== undefined) {
            for (const mid of cachedMembers) {
              const r = model.objects[mid];
              if (r !== undefined && logicalIdOf(r) === logical)
                groupMembers.push(r);
            }
          }
          const cachedGroups = this.cachedGroups?.get(logical);
          if (cachedGroups !== undefined) {
            for (const r of cachedGroups.records) {
              if (
                model.objects[r.id] !== undefined &&
                !groupMembers.some((g) => g.id === r.id)
              ) {
                groupMembers.push(r);
              }
            }
          }
          for (const mid of contentMutatedIds) {
            const r = model.objects[mid];
            if (
              r !== undefined &&
              logicalIdOf(r) === logical &&
              !groupMembers.some((g) => g.id === mid)
            ) {
              groupMembers.push(r);
            }
          }
          groupMembers.sort(
            (a, b) => (chunkIndexOf(a) ?? 0) - (chunkIndexOf(b) ?? 0),
          );
          if (groupMembers.length > 0) {
            const head = groupMembers[0]!;
            const joint: SurfaceObjectRecord = {
              ...head,
              id: logical,
              points: groupMembers.flatMap((r) => {
                const pts = (r as Record<string, unknown>).points;
                return Array.isArray(pts) ? (pts as never[]) : [];
              }) as never,
            };
            const items2 = compileUpdated(joint);
            this.compiledByKey.set(logical, items2);
            this.logicalMembers.set(
              logical,
              new Set(groupMembers.map((r) => r.id)),
            );
            for (const m of groupMembers) this.chunkToKey.set(m.id, logical);
            ordered.push(...items2);
            recompiled += 1;
          }
        }
        continue;
      }
      const key = id;
      if (emitted.has(key)) continue;
      emitted.add(key);
      const items = this.compiledByKey.get(key);
      if (items !== undefined) {
        ordered.push(...items);
      } else if (affected.has(key)) {
        // Cache miss for an actually-mutated key (e.g., undo restore):
        // compile just it (bounded). Unprepared keys (lazy open) are
        // skipped — see above.
        const items2 = compileUpdated(record);
        this.compiledByKey.set(key, items2);
        ordered.push(...items2);
        recompiled += 1;
      }
    }
    // Evict cache entries for keys no longer present (deleted logicals
    // whose chunks are all gone, without needing a sample scan).
    if (emitted.size < this.compiledByKey.size) {
      for (const key of [...this.compiledByKey.keys()]) {
        if (!emitted.has(key)) {
          this.compiledByKey.delete(key);
          if (this.logicalMembers.has(key)) {
            const members = this.logicalMembers.get(key)!;
            for (const chunkId of members) this.chunkToKey.delete(chunkId);
            this.logicalMembers.delete(key);
          }
        }
      }
    }
    for (const key of deferred) this.compiledByKey.delete(key);
    this.lastOrder = [...model.order];
    this.refreshOrderRank(model);
    // Keep the cached logical index (item 4) in sync incrementally: only
    // affected logicals refresh, never a full regroup here. New chunk
    // identities arriving via mutations update their entries; deletions
    // drop theirs. Progressive slices therefore reuse the cache.
    if (this.cachedGroups !== null && contentMutatedIds.length > 0) {
      for (const key of affected) {
        const members = this.logicalMembers.get(key);
        if (members !== undefined) {
          const records: SurfaceObjectRecord[] = [];
          for (const chunkId of members) {
            const rec = model.objects[chunkId];
            if (rec !== undefined) records.push(rec);
          }
          records.sort(
            (a, b) => (chunkIndexOf(a) ?? 0) - (chunkIndexOf(b) ?? 0),
          );
          if (records.length > 0) {
            this.cachedGroups.set(key, {
              logicalId: key,
              chunkIds: records.map((r) => r.id),
              records,
            });
          } else {
            this.cachedGroups.delete(key);
          }
        } else if (this.cachedGroups.has(key)) {
          // Affected non-logical key that was previously grouped (deleted
          // logical): drop the stale group entry.
          this.cachedGroups.delete(key);
        }
      }
      // New logicals whose chunks arrived as brand-new ids (not in previous
      // members) claim their key via chunkToKey — ensure the group entry
      // exists without a full rescan by gathering siblings from the mutated
      // set plus existing members (bounded, no model scan).
      for (const id of contentMutatedIds) {
        const rec = model.objects[id];
        if (rec === undefined) continue;
        const logical = logicalIdOf(rec);
        if (logical !== null && !this.cachedGroups.has(logical)) {
          const siblings: SurfaceObjectRecord[] = [];
          const memberIds = this.logicalMembers.get(logical);
          if (memberIds !== undefined) {
            for (const mid of memberIds) {
              const r = model.objects[mid];
              if (r !== undefined) siblings.push(r);
            }
          }
          if (!siblings.some((r) => r.id === id)) siblings.push(rec);
          siblings.sort(
            (a, b) => (chunkIndexOf(a) ?? 0) - (chunkIndexOf(b) ?? 0),
          );
          this.cachedGroups.set(logical, {
            logicalId: logical,
            chunkIds: siblings.map((r) => r.id),
            records: siblings,
          });
        }
      }
    }
    this.stats.newlyCompiledObjects = recompiled - deferred.size;
    this.stats.cachedObjects = this.compiledByKey.size;
    // oldStrokeCompiles / fingerprintScans stay 0 by construction: we
    // never touch unchanged keys' samples.
    return ordered;
  }

  /** Current ordered items without recompiling (camera-only moves). */
  current(): readonly PreparedItem[] | null {
    if (this.compiledByKey.size === 0) return null;
    return null;
  }
}
