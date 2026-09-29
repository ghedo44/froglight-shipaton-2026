/**
 * Derived-cache reopen integration (final scalability pass: real derived
 * reopen cache; live revision ownership; asynchronous durable storage).
 *
 * ```text
 * canonical bytes ──(session, once)──▶ content revision (LIVE)
 *         │
 *         ▼
 * kind.decode ──▶ model + decode-time seeds (no checksum pass here)
 *         │
 *         ▼
 * resolveReopenSeeds(documentId, revision, decodeSeeds, cache)
 *         │         ▲ prefers valid cache entries, else decode seeds
 *         │         │ stores decode seeds for the next open
 *         ▼         │
 * mount seeds ──────┘
 *         │
 *         ▼
 * restoreCachedCompiledGeometry(documentId, revision, model, cache)
 *         │         ▲ installs validated packed vectors (zero compiles)
 *         ▼         │
 * first viewport renders cached vectors immediately
 *
 * teardown: scheduleWarmCompiledGeometry(...)  (returns immediately)
 *         │
 *         ▼
 * async job: pack warm (translation-rebased) vectors → binary container
 *            → host storage (Tauri cache dir / OPFS / memory)
 * ```
 *
 * The cache is NEVER authoritative: entries are keyed by
 * (documentId, objectId, canonical content revision, ink compiler
 * version, cache schema version). Any mismatch — revision, compiler,
 * schema, corrupt payload — falls back to decode seeds + Worker
 * recompile. Canonical data is never repaired or mutated from cache
 * contents. Live predictions and transient selection state are never
 * persisted.
 *
 * Revision ownership is LIVE (`SurfaceReopenBinding.getContentRevision`)
 * and persistence is DIRTY-GATED (`isDirty`): geometry for unsaved edits
 * can never be stored under the last saved revision, and after a
 * successful save the next persistence uses the new revision.
 * Persistence is asynchronous: `destroy()` only enqueues work, and jobs
 * for revisions that have moved on are discarded without touching
 * storage. Durable payloads are compact binary (never base64).
 */

import {
  SurfaceDerivedCache,
  derivedCacheKey,
  derivedCacheEntryStorageKey,
  decodeDerivedCacheEntry,
  decodeDerivedCacheManifest,
  encodeDerivedCacheEntry,
  encodeDerivedCacheManifest,
  DERIVED_CACHE_MAX_COMPILED,
  DERIVED_CACHE_MAX_COMPILED_BYTES,
  DERIVED_CACHE_DURABLE_MAX_BYTES,
  DERIVED_CACHE_VERSION,
  serializeDerivedCacheBinary,
  type CachedDerivedBounds,
  type DerivedCacheKey,
  type DerivedCacheManifest,
} from './derived-cache.js';
import { INK_COMPILER_VERSION } from './objects.js';
import { chunkIndexOf, logicalIdOf } from './model.js';
import { SURFACE_CANONICAL_CHECKSUM_KEY } from './open-metadata.js';
import type { Bounds } from './geometry.js';
import {
  packedCompiledByteLength,
  packedSamplesTransfer,
  rebasePackedCompiledInk,
  unpackCompiledInk,
  type PackedCompiledInk,
  type PackedInkCompileRequest,
  type PackedInkCompileResponse,
  type PackedInkSamples,
} from './ink/packed-protocol.js';
import {
  derivedTranslationOfRecord,
  hasRichCompiledGeometry,
  isCompiledWarm,
  jointPackedForChunk,
  jointTranslationOfPacked,
  jointTranslationForChunk,
  logicalGeometryGeneration,
  logicalPositionGeneration,
  packedCompiledForRecord,
  recordGeometryGeneration,
  recordPositionGeneration,
  retainJointPackedForChunks,
  retainPackedForRecord,
  retainPackedOnlyForRecord,
  resolveStrokeBrush,
  setCompiledForRecord,
  type PreparedBackgroundPackUnit,
} from './objects.js';
import type { SurfaceModel, SurfaceObjectRecord } from './model.js';
import { yieldToEventLoop } from './ink/async-compiler.js';
import type { CompiledRestoreSource } from './incremental-scene.js';
import type { InkBrushSpec } from './ink/brush.js';
import type { ColdCompileWorker } from './ink/cold-scheduler.js';

/** Worker lane for background live-stroke packing (same protocol as cold compile). */
export type BackgroundPackWorker = Pick<
  ColdCompileWorker,
  'postMessage' | 'onmessage' | 'onerror' | 'terminate'
>;

/** `openMetadata` key carrying the canonical-bytes checksum (FNV-1a hex). */
export { SURFACE_CANONICAL_CHECKSUM_KEY };

export interface ReopenSeedStats {
  /** Objects seeded from a valid cache entry. */
  hits: number;
  /** Objects seeded from decode (cache miss or invalid). */
  misses: number;
  /** Decode seeds stored into the cache for the next open. */
  stores: number;
}

export interface ResolveReopenSeedsInput {
  /** Stable document identity (matches the cache's document scope). */
  readonly documentId: string;
  /**
   * Canonical content revision for this open: the session-owned token
   * (`DOCUMENT_CONTENT_REVISION_KEY`), computed once when bytes enter
   * the session layer — never rescanned inside decoders.
   */
  readonly revision: string;
  /** Fresh decode-time seeds for every Ink object in the model. */
  readonly decodeSeeds: ReadonlyMap<string, Bounds | null>;
  /** Owner-held derived cache (per-document lifetime, see below). */
  readonly cache: SurfaceDerivedCache;
}

export interface ResolveReopenSeedsResult {
  /** Effective mount seeds (cache hits + decode fallbacks, same keys). */
  readonly seeds: ReadonlyMap<string, Bounds | null>;
  readonly stats: ReopenSeedStats;
}

/**
 * Resolve effective mount seeds from cache + decode. Pure apart from the
 * cache reads/writes it performs; never throws (corrupt entries fall
 * back to decode seeds).
 */
export function resolveReopenSeeds(
  input: ResolveReopenSeedsInput,
): ResolveReopenSeedsResult {
  const out = new Map<string, Bounds | null>();
  const stats: ReopenSeedStats = { hits: 0, misses: 0, stores: 0 };
  for (const [objectId, decoded] of input.decodeSeeds) {
    let key: DerivedCacheKey;
    try {
      key = derivedCacheKey(input.documentId, objectId, input.revision);
    } catch {
      out.set(objectId, decoded);
      stats.misses += 1;
      continue;
    }
    let cached: Bounds | null | undefined;
    try {
      cached = input.cache.loadBounds(key);
    } catch {
      cached = undefined;
    }
    if (cached !== undefined) {
      out.set(objectId, cached);
      stats.hits += 1;
      continue;
    }
    out.set(objectId, decoded);
    stats.misses += 1;
    try {
      input.cache.storeBounds(key, decoded);
      stats.stores += 1;
    } catch {
      // Cache writes never break opening.
    }
  }
  return { seeds: out, stats };
}

export interface RestoreCompiledInput {
  /** Stable document identity (matches the cache's document scope). */
  readonly documentId: string;
  /** Canonical content revision for this open (session-owned token). */
  readonly revision: string;
  /** Opened canonical model (records install unpacked geometry). */
  readonly model: Pick<SurfaceModel, 'objects' | 'order'>;
  /** Owner-held derived cache. */
  readonly cache: SurfaceDerivedCache;
}

export interface RestoreCompiledStats {
  /** Objects whose packed vectors restored (zero B-spline compiles). */
  hits: number;
  /** Objects without a valid entry (Worker compiles these). */
  misses: number;
}

/**
 * Install validated packed vectors for unchanged content (reopen hit
 * path): every valid entry unpacks into the record's compiled cache, so
 * the first viewport renders cached vectors immediately with no
 * B-spline compile. Corrupt entries miss (safe Worker recompile) and
 * never prevent opening. Never throws.
 *
 * This is the EAGER whole-document variant (direct/test callers). Mounts
 * use `createCachedCompiledRestore` instead, which unpacks only as
 * objects enter viewport/progressive preparation priority.
 */
export function restoreCachedCompiledGeometry(
  input: RestoreCompiledInput,
): RestoreCompiledStats {
  const stats: RestoreCompiledStats = { hits: 0, misses: 0 };
  for (const objectId of input.model.order) {
    const record = (
      input.model as {
        objects: Record<string, (typeof input.model.objects)[string]>;
      }
    ).objects[objectId];
    if (record === undefined) continue;
    let packed: PackedCompiledInk | undefined;
    try {
      packed = input.cache.loadCompiled(
        derivedCacheKey(input.documentId, objectId, input.revision),
      );
    } catch {
      packed = undefined;
    }
    if (packed === undefined) {
      stats.misses += 1;
      continue;
    }
    try {
      // Retain the packed copy so persistence can reuse it (never repack
      // an identical object graph).
      setCompiledForRecord(record, unpackCompiledInk(packed), packed);
      stats.hits += 1;
    } catch {
      stats.misses += 1;
    }
  }
  return stats;
}

export interface CachedCompiledRestoreStats {
  /** Packed entries unpacked + installed as their objects prepared. */
  restored: number;
  /** Objects entering preparation with no valid packed entry. */
  misses: number;
  /** Wall-clock ms spent unpacking/installing (main thread). */
  restoreMs: number;
  /** Packed bytes unpacked (integration pressure proxy). */
  restoredBytes: number;
  /** Spine nodes materialized from restored packed vectors. */
  restoredNodes: number;
  /** Restore attempts skipped because the live session is dirty. */
  dirtySkips: number;
  /** Restore attempts skipped because no live revision is available. */
  revisionSkips: number;
}

/**
 * Viewport-first lazy restore source (dense-document reopen).
 *
 * Mounts attach this to the committed renderer's scene cache; it is
 * consulted ONLY when an object actually enters preparation priority
 * (strict viewport first, then prefetch margin, then bounded offscreen).
 * Packed entries stay packed in the derived cache until then — a
 * 1000-stroke document never synchronously unpacks its whole cache at
 * mount/hydration. Claims (`takeCompiled`) remove each entry, so a
 * restored object is never restored twice and the cache's byte
 * accounting drops the packed copy once its retained home is the record.
 */
export function createCachedCompiledRestore(input: {
  readonly documentId: string;
  readonly revision: string;
  readonly cache: SurfaceDerivedCache;
}): CompiledRestoreSource & {
  stats(): CachedCompiledRestoreStats;
  /** Restored + still-packed entries for this document/revision. */
  available(): number;
  /** Packed entries not yet claimed (still packed, lazy). */
  pending(): number;
} {
  const stats: CachedCompiledRestoreStats = {
    restored: 0,
    misses: 0,
    restoreMs: 0,
    restoredBytes: 0,
    restoredNodes: 0,
    dirtySkips: 0,
    revisionSkips: 0,
  };
  const now = (): number => {
    try {
      const perf = (
        globalThis as unknown as { performance?: { now(): number } }
      ).performance;
      if (perf !== undefined && typeof perf.now === 'function') {
        return perf.now();
      }
    } catch {
      // Fall through to Date.now.
    }
    return Date.now();
  };
  return {
    restore(record: SurfaceObjectRecord): boolean {
      try {
        const key = derivedCacheKey(
          input.documentId,
          record.id,
          input.revision,
        );
        const packed = input.cache.takeCompiled(key);
        if (packed === undefined) {
          stats.misses += 1;
          return false;
        }
        const start = now();
        setCompiledForRecord(record, unpackCompiledInk(packed), packed);
        stats.restoreMs += now() - start;
        stats.restoredBytes += packedCompiledByteLength(packed);
        stats.restoredNodes += packed.nodeCount;
        stats.restored += 1;
        return true;
      } catch {
        // Corrupt/unsupported payload: safe miss, Worker compiles.
        stats.misses += 1;
        return false;
      }
    },
    stats: () => ({ ...stats }),
    available: () => stats.restored + input.cache.compiledEntryCount(),
    pending: () => input.cache.compiledEntryCount(),
  };
}

/**
 * Live-revision lazy restore source (closure-pass correctness fix).
 *
 * Unlike `createCachedCompiledRestore` (which captures documentId/revision/
 * cache at mount), this source captures only the live `SurfaceReopenBinding`
 * and reads the CURRENT binding at every restore attempt:
 *
 * ```text
 * if binding is dirty: miss
 * revision = liveContentRevision(binding); if null: miss
 * cache = binding.store.acquire(documentId, revision)
 * attempt restore using exactly that revision
 * ```
 *
 * There is no permanently captured revision/cache capable of serving R0
 * geometry after the session moves to R1. Async durable hydration is
 * revision-safe via store generation/entry identity (a late R0 load can
 * never become visible after R1 is current).
 */
export function createLiveCachedCompiledRestore(
  binding: SurfaceReopenBinding,
): CompiledRestoreSource & {
  stats(): CachedCompiledRestoreStats;
  available(): number;
  pending(): number;
  hasDurable(objectId: string): boolean;
  hasMemoryPacked(objectId: string): boolean;
  preload(objectIds: readonly string[]): void;
  loadPackedEntry(objectId: string): Promise<PackedCompiledInk | null>;
} {
  const stats: CachedCompiledRestoreStats = {
    restored: 0,
    misses: 0,
    restoreMs: 0,
    restoredBytes: 0,
    restoredNodes: 0,
    dirtySkips: 0,
    revisionSkips: 0,
  };
  const now = (): number => {
    try {
      const perf = (
        globalThis as unknown as { performance?: { now(): number } }
      ).performance;
      if (perf !== undefined && typeof perf.now === 'function') {
        return perf.now();
      }
    } catch {
      // Fall through to Date.now.
    }
    return Date.now();
  };
  const liveCacheForAttempt = (): {
    cache: SurfaceDerivedCache;
    revision: string;
  } | null => {
    if (liveIsDirty(binding)) {
      stats.dirtySkips += 1;
      stats.misses += 1;
      return null;
    }
    const revision = liveContentRevision(binding);
    if (revision === null) {
      stats.revisionSkips += 1;
      stats.misses += 1;
      return null;
    }
    try {
      const cache = binding.store.acquire(binding.documentId, revision);
      return { cache, revision };
    } catch {
      stats.misses += 1;
      return null;
    }
  };
  const liveRevisionForProbe = (): string | null => {
    try {
      if (liveIsDirty(binding)) return null;
      return liveContentRevision(binding);
    } catch {
      return null;
    }
  };
  return {
    restore(record: SurfaceObjectRecord): boolean {
      const attempt = liveCacheForAttempt();
      if (attempt === null) return false;
      try {
        const key = derivedCacheKey(
          binding.documentId,
          record.id,
          attempt.revision,
        );
        const packed = attempt.cache.takeCompiled(key);
        if (packed === undefined) {
          stats.misses += 1;
          return false;
        }
        const start = now();
        setCompiledForRecord(record, unpackCompiledInk(packed), packed);
        stats.restoreMs += now() - start;
        stats.restoredBytes += packedCompiledByteLength(packed);
        stats.restoredNodes += packed.nodeCount;
        stats.restored += 1;
        return true;
      } catch {
        stats.misses += 1;
        return false;
      }
    },
    restorePacked(record: SurfaceObjectRecord): PackedCompiledInk | undefined {
      if (liveIsDirty(binding)) {
        stats.dirtySkips += 1;
        stats.misses += 1;
        return undefined;
      }
      const revision = liveContentRevision(binding);
      if (revision === null) {
        stats.revisionSkips += 1;
        stats.misses += 1;
        return undefined;
      }
      try {
        const cache = binding.store.acquire(binding.documentId, revision);
        const packed = cache.takeCompiled(
          derivedCacheKey(binding.documentId, record.id, revision),
        );
        if (packed === undefined) {
          stats.misses += 1;
          return undefined;
        }
        // Packed rendering: no unpack, no B-spline, no object-graph
        // expansion. Retain the packed copy on the record for persistence
        // reuse WITHOUT installing rich geometry (hit-test/selection lazily
        // materialize single items on demand).
        try {
          retainPackedOnlyForRecord(record, packed);
        } catch {
          // Retention never breaks restore.
        }
        stats.restoredBytes += packedCompiledByteLength(packed);
        stats.restoredNodes += packed.nodeCount;
        stats.restored += 1;
        return packed;
      } catch {
        stats.misses += 1;
        return undefined;
      }
    },
    hasDurable(objectId: string): boolean {
      const revision = liveRevisionForProbe();
      if (revision === null) return false;
      try {
        return binding.store.hasDurableEntry(
          binding.documentId,
          revision,
          objectId,
        );
      } catch {
        return false;
      }
    },
    hasMemoryPacked(objectId: string): boolean {
      const revision = liveRevisionForProbe();
      if (revision === null) return false;
      try {
        return binding.store.hasMemoryPacked(
          binding.documentId,
          revision,
          objectId,
        );
      } catch {
        return false;
      }
    },
    preload(objectIds: readonly string[]): void {
      const revision = liveRevisionForProbe();
      if (revision === null || objectIds.length === 0) return;
      for (const objectId of objectIds) {
        try {
          void binding.store.loadDurableEntry(
            binding.documentId,
            revision,
            objectId,
          );
        } catch {
          // Preload never breaks preparation.
        }
      }
    },
    loadPackedEntry(objectId: string): Promise<PackedCompiledInk | null> {
      const revision = liveRevisionForProbe();
      if (revision === null) return Promise.resolve(null);
      try {
        return binding.store.loadDurableEntry(
          binding.documentId,
          revision,
          objectId,
        );
      } catch {
        return Promise.resolve(null);
      }
    },
    stats: () => ({ ...stats }),
    available: () => {
      const attemptRevision = (() => {
        try {
          if (liveIsDirty(binding)) return null;
          return liveContentRevision(binding);
        } catch {
          return null;
        }
      })();
      if (attemptRevision === null) return stats.restored;
      try {
        const cache = binding.store.acquire(
          binding.documentId,
          attemptRevision,
        );
        return stats.restored + cache.compiledEntryCount();
      } catch {
        return stats.restored;
      }
    },
    pending: () => {
      try {
        if (liveIsDirty(binding)) return 0;
        const revision = liveContentRevision(binding);
        if (revision === null) return 0;
        return binding.store
          .acquire(binding.documentId, revision)
          .compiledEntryCount();
      } catch {
        return 0;
      }
    },
  };
}

export interface PersistCompiledStats {
  /** Warm records packed into the cache for the next open. */
  stores: number;
}

/** Warm records queued for one persistence pass, before packing. */
function collectWarmRecords(
  model: Pick<SurfaceModel, 'objects' | 'order'>,
): SurfaceObjectRecord[] {
  const objects = (
    model as { objects: Record<string, SurfaceObjectRecord | undefined> }
  ).objects;
  const warm: SurfaceObjectRecord[] = [];
  for (const objectId of model.order) {
    const record = objects[objectId];
    if (record === undefined) continue;
    try {
      // Persistable packed only (rich-warm WITH retained packed, or
      // packed-only renders): unpacked live records are skipped —
      // background packing retains them for a later teardown.
      // Joint chunks (logical strokes with retained joint packed) are
      // included so teardown persists one stable joint entry per logical.
      if (packedCompiledForRecord(record) !== undefined) warm.push(record);
      else if (jointPackedForChunk(record) !== undefined) warm.push(record);
    } catch {
      // A throwing warm probe skips only that record.
    }
  }
  return warm;
}

/**
 * World-coordinate packed geometry for one warm record, produced WITHOUT
 * recompiling and WITHOUT repacking when a retained packed copy exists.
 * `undefined` means nothing to persist (no compiled geometry OR no retained
 * packed copy).
 *
 * Closure-pass ownership (zero-main-thread teardown): teardown gathers ONLY
 * already-packed entries. Live strokes without a retained packed copy are
 * SKIPPED (disposable cache — UI responsiveness beats completeness). They
 * acquire a retained copy via the low-priority background packing lane
 * (`scheduleBackgroundPackForRecords`) shortly after commit, so a later
 * teardown will persist them without any synchronous `packCompiledInk`.
 */
function worldPackedForRecord(
  record: SurfaceObjectRecord,
): PackedCompiledInk | undefined {
  const translation = derivedTranslationOfRecord(record);
  const retained = packedCompiledForRecord(record);
  if (retained === undefined) return undefined;
  // Reuse the packed representation: rebase copies only XY fields and
  // only on the translated path; zero translation returns it verbatim.
  return rebasePackedCompiledInk(retained, translation.tx, translation.ty);
}

/**
 * Tripwire: synchronous `packCompiledInk` calls from teardown/persistence
 * collection paths. Must stay 0 — teardown gathers only already-packed
 * entries (see `worldPackedForRecord`). Background packing (`schedule-
 * BackgroundPackForRecords`) packs off the teardown path and does NOT
 * increment this counter.
 */
export const persistenceTripwires = {
  mainThreadPersistencePacks: 0,
};

/**
 * Low-priority background packing lane (closure-pass item 4).
 *
 * Live strokes render immediately via the rich compiler; this lane retains
 * a reusable `PackedCompiledInk` shortly afterwards so a later teardown can
 * persist without any synchronous packing. Idle-scheduled, never on the
 * teardown path. If teardown arrives before packing finishes, the record is
 * skipped (disposable cache).
 *
 * Canonical copying is bounded and resumable (≤2000 samples/slice,
 * `requestIdleCallback` deadlines respected). The destination typed-array
 * allocation in `createBackgroundInputJob()` remains a measured one-shot
 * O(N) initialization (6 buffers; real Chromium `background-init` bench:
 * 100k ≈1.2ms cold / 0.2ms warm, 500k ≈6.3ms cold / 0.6ms warm, versus
 * sliced copying at 100k ≈7–30ms and 500k ≈36–104ms total across 50/250
 * slices). The one-shot init is insignificant under the idle responsiveness
 * budget, so the Worker protocol was intentionally left unchanged — but it
 * is NOT claimed as bounded. See `timeBackgroundInputInit`.
 *
 * Reuses the existing packed protocol (same field mapping as
 * `packCompiledInk`, same `PackedCompiledInk` representation). No new
 * geometry representation, no canonical change, no delayed committed
 * rendering (rich stays usable while packing runs).
 */
export const MAX_MAIN_THREAD_PACK_CHUNK_ITEMS = 2000;
/**
 * Bounded canonical-input COPY budget for background Worker packing
 * (FINAL §4.2): at most this many canonical samples are copied into
 * transferable typed arrays per scheduling slice. No single copy slice walks
 * all 100k samples. The destination buffer allocation itself is a separate
 * measured one-shot O(N) init (see the lane comment and
 * `timeBackgroundInputInit()`), not covered by this per-slice budget.
 */
export const BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE = 2000;

const backgroundPackQueue: SurfaceObjectRecord[] = [];
/**
 * Scene-prepared LOGICAL units waiting for a joint Worker job. A chunked
 * logical stroke is one rendered/compiled unit in the committed scene even
 * though its canonical chunks are separate records; individual chunks
 * generally do NOT own independent rich compiled geometry, so logical units
 * are queued here explicitly instead of being forced through the
 * per-record warm/rich queue. Member identity/epochs are revalidated when
 * the job is created and again on Worker completion.
 */
interface PreparedLogicalPackRequest {
  readonly logicalId: string;
  readonly ids: readonly string[];
  /** Scheduling-time record references (model-less tests). */
  readonly records: readonly SurfaceObjectRecord[];
  readonly model: Pick<SurfaceModel, 'objects'> | null;
  /** Logical geometry epoch when scheduled (defense-in-depth recheck). */
  readonly logicalGeneration: number | null;
  /** Logical position epoch when scheduled (translation race recheck). */
  readonly logicalPosition: number | null;
}

const preparedLogicalPackQueue: PreparedLogicalPackRequest[] = [];
/**
 * Owning model per queued record (production passes its SurfaceModel so
 * Worker completion can verify record identity/membership: deletion leaves
 * `model.objects[id]` missing and same-id replacement leaves a different
 * JS object. Tests omit the model and rely on the generation epochs alone.
 */
let backgroundPackModelByRecord = new WeakMap<
  object,
  Pick<SurfaceModel, 'objects'>
>();

function backgroundPackModelFor(
  record: SurfaceObjectRecord,
): Pick<SurfaceModel, 'objects'> | null {
  try {
    return backgroundPackModelByRecord.get(record as object) ?? null;
  } catch {
    return null;
  }
}
let backgroundPackScheduled = false;
/** Active background input/Worker job (at most one; giant strokes span slices). */
let activeBackgroundPackJob: BackgroundPackInputJob | null = null;
/** In-flight Worker request (input complete, awaiting Worker compile+pack). */
let activeBackgroundWorkerPending: {
  readonly requestId: string;
  readonly job: BackgroundPackInputJob;
} | null = null;
let backgroundPackWorkerFactory: (() => BackgroundPackWorker | null) | null =
  null;
let backgroundPackWorker: BackgroundPackWorker | null = null;
let backgroundPackWorkerDead = false;
let backgroundPackRequestCounter = 0;
export const backgroundPackStats = {
  queued: 0,
  started: 0,
  completed: 0,
  cancelled: 0,
  /** Jobs completed via the chunked main-thread packer (always 0: removed). */
  fallbackJobs: 0,
  /** Jobs completed via the background Worker lane. */
  workerJobs: 0,
  /** Packed bytes retained by background packing. */
  bytes: 0,
  /** Idle slices that performed input-preparation work. */
  mainThreadChunks: 0,
  /** Largest single-slice input-sample count (must stay ≤ input budget). */
  maxMainThreadPackChunkItems: 0,
  // FINAL §4.5 truthful counters (aliases kept in sync with legacy names):
  /** Jobs queued for background packing. */
  jobsQueued: 0,
  /** Input-preparation slices performed. */
  inputChunks: 0,
  /** Canonical input samples copied into transferable buffers. */
  inputSamples: 0,
  /** Worker jobs posted (canonical transport → Worker compile+pack). */
  workerCompleted: 0,
  /** Jobs discarded without Worker execution (no Worker / failure / cancel). */
  workerCancelled: 0,
  /** Worker results discarded as stale (never installed). */
  workerStaleDrops: 0,
  /** Packed input bytes transferred to the Worker. */
  inputBytes: 0,
  /** Packed output bytes retained from the Worker. */
  outputBytes: 0,
  /** Full rich→packed conversions on the main thread (tripwire, always 0). */
  mainThreadFullPacks: 0,
  /** Largest single-slice input-sample copy (must stay ≤ budget). */
  maxInputSamplesPerSlice: 0,
};

/** Backwards-compatible aliases for earlier diagnostic names. */
export const backgroundPackDiagnostics = backgroundPackStats;

/**
 * Background Worker packing lane (FINAL §4).
 * Replaces the old main-thread rich→packed chunker (which still performed
 * O(N) init on the UI thread) with bounded canonical-input preparation +
 * off-thread compile+pack. This file is spliced into derived-reopen.ts.
 */

interface BackgroundPackInputJob {
  readonly kind: 'single' | 'joint';
  readonly requestKey: string;
  readonly records: readonly SurfaceObjectRecord[];
  readonly recordIds: readonly string[];
  readonly logicalId: string | null;
  readonly totalSamples: number;
  readonly brush: InkBrushSpec;
  readonly initialSampleCounts: readonly number[];
  /** Per-record geometry epochs captured at job creation (id-keyed). */
  readonly initialRecordGenerations: readonly number[];
  /** Joint logical epoch captured at job creation (joint jobs only). */
  readonly initialLogicalGeneration: number | null;
  /**
   * Per-record background-pack position epochs captured at job creation.
   * Advanced by rigid translation via `accumulateDerivedTranslation`
   * (O(moved ids)); geometry generations deliberately do not cover this.
   */
  readonly initialRecordPositions: readonly number[];
  /** Joint logical position epoch captured at job creation (joint jobs). */
  readonly initialLogicalPosition: number | null;
  /**
   * Meaningful geometry epoch sent as the Worker request `generation`:
   * the record epoch for singles, the logical epoch for joints. Never a
   * hardcoded 0 and never an unrelated request counter.
   */
  readonly generation: number;
  readonly initialTx: number;
  readonly initialTy: number;
  readonly initialJointTx: number;
  readonly initialJointTy: number;
  /** Optional owning model for identity/membership validation (production). */
  readonly model: Pick<SurfaceModel, 'objects'> | null;
  readonly positionXY: Float64Array;
  readonly pressure: Float32Array;
  readonly tiltXY: Float32Array;
  readonly twist: Float32Array;
  readonly dt: Float64Array;
  readonly presence: Uint8Array;
  extras: (Record<string, unknown> | undefined)[] | undefined;
  nextSample: number;
  inputBytes: number;
}

function backgroundInputByteLength(total: number): number {
  return (
    total * 2 * 8 + total * 4 + total * 2 * 4 + total * 4 + total * 8 + total
  );
}

function createBackgroundInputJob(
  records: readonly SurfaceObjectRecord[],
  logicalId: string | null,
  model: Pick<SurfaceModel, 'objects'> | null = null,
): BackgroundPackInputJob | null {
  try {
    let total = 0;
    const counts: number[] = [];
    for (const r of records) {
      const pts = (r as Record<string, unknown>).points;
      const n = Array.isArray(pts) ? pts.length : 0;
      counts.push(n);
      total += n;
    }
    if (total === 0) return null;
    if (total > 500000) return null;
    let brush: InkBrushSpec;
    try {
      const head = records[0]!;
      brush = resolveStrokeBrush(head);
    } catch {
      return null;
    }
    // Capture geometry epochs at creation: per-record epochs for every
    // participant plus the joint logical epoch for logical jobs. The sent
    // Worker `generation` is the relevant epoch (record for singles,
    // logical for joints) — never hardcoded 0. Position epochs are
    // captured alongside: rigid translation advances ONLY the position
    // epochs (never geometry), so a job that copied coordinates from a
    // different canonical position must go stale even when every geometry
    // check still passes.
    const recordIds = records.map((r) => r.id);
    const recordGenerations = recordIds.map((id) => {
      try {
        return model === null ? 0 : recordGeometryGeneration(model, id);
      } catch {
        return 0;
      }
    });
    const recordPositions = recordIds.map((id) => {
      try {
        return model === null ? 0 : recordPositionGeneration(model, id);
      } catch {
        return 0;
      }
    });
    let logicalGeneration: number | null = null;
    let logicalPosition: number | null = null;
    if (logicalId !== null) {
      try {
        logicalGeneration =
          model === null ? 0 : logicalGeometryGeneration(model, logicalId);
      } catch {
        logicalGeneration = 0;
      }
      try {
        logicalPosition =
          model === null ? 0 : logicalPositionGeneration(model, logicalId);
      } catch {
        logicalPosition = 0;
      }
    }
    const generation =
      logicalId !== null
        ? (logicalGeneration ?? 0)
        : (recordGenerations[0] ?? 0);
    let initialTx = 0;
    let initialTy = 0;
    let initialJointTx = 0;
    let initialJointTy = 0;
    try {
      if (logicalId === null) {
        const t = derivedTranslationOfRecord(records[0]!);
        initialTx = t.tx;
        initialTy = t.ty;
      } else {
        const joint = jointPackedForChunk(records[0]!);
        if (joint !== undefined) {
          const jt = jointTranslationOfPacked(joint);
          initialJointTx = jt.tx;
          initialJointTy = jt.ty;
        }
        const t0 = derivedTranslationOfRecord(records[0]!);
        initialTx = t0.tx;
        initialTy = t0.ty;
      }
    } catch {
      // Probing never blocks queueing.
    }
    const positionXY = new Float64Array(total * 2);
    const pressure = new Float32Array(total);
    const tiltXY = new Float32Array(total * 2);
    const twist = new Float32Array(total);
    const dt = new Float64Array(total);
    const presence = new Uint8Array(total);
    return {
      kind: logicalId === null ? 'single' : 'joint',
      requestKey: `${logicalId ?? records[0]!.id}`,
      records,
      recordIds,
      logicalId,
      totalSamples: total,
      brush,
      initialSampleCounts: counts,
      initialRecordGenerations: recordGenerations,
      initialLogicalGeneration: logicalGeneration,
      initialRecordPositions: recordPositions,
      initialLogicalPosition: logicalPosition,
      generation,
      initialTx,
      initialTy,
      initialJointTx,
      initialJointTy,
      model,
      positionXY,
      pressure,
      tiltXY,
      twist,
      dt,
      presence,
      extras: undefined,
      nextSample: 0,
      inputBytes: backgroundInputByteLength(total),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve one queued scene-prepared logical request into a joint input job.
 * Re-resolves CURRENT canonical members when the owning model is known
 * (durable membership source), requires every captured id to still exist
 * and still belong to the logical, preserves `chunkIndex` order, and
 * rejects requests whose logical epoch advanced after scheduling. Returns
 * null when the request is stale/gone (dropped without Worker work).
 */
function createPreparedLogicalJob(
  request: PreparedLogicalPackRequest,
): BackgroundPackInputJob | null {
  try {
    const model = request.model;
    // Any membership/geometry mutation after scheduling advances the
    // logical epoch; the prepared scene truth is no longer current.
    if (model !== null && request.logicalGeneration !== null) {
      if (
        logicalGeometryGeneration(model, request.logicalId) !==
        request.logicalGeneration
      ) {
        return null;
      }
    }
    // Rigid translation after scheduling advances ONLY the position
    // epoch (geometry deliberately unchanged): the prepared input would
    // otherwise copy coordinates from a different canonical position.
    if (model !== null && request.logicalPosition !== null) {
      if (
        logicalPositionGeneration(model, request.logicalId) !==
        request.logicalPosition
      ) {
        return null;
      }
    }
    const records: SurfaceObjectRecord[] = [];
    for (const id of request.ids) {
      let record: SurfaceObjectRecord | undefined;
      if (model !== null) {
        record = modelObjects(model)[id];
      } else {
        record = request.records.find((candidate) => candidate.id === id);
      }
      if (record === undefined) return null;
      try {
        if (logicalIdOf(record) !== request.logicalId) return null;
      } catch {
        return null;
      }
      if (!records.includes(record)) records.push(record);
    }
    if (records.length === 0) return null;
    // A retained joint that appeared after scheduling already covers
    // persistence; drop the redundant Worker work.
    for (const record of records) {
      try {
        if (jointPackedForChunk(record) !== undefined) return null;
      } catch {
        return null;
      }
    }
    records.sort((a, b) => (chunkIndexOf(a) ?? 0) - (chunkIndexOf(b) ?? 0));
    return createBackgroundInputJob(records, request.logicalId, model);
  } catch {
    return null;
  }
}

/** Loose `objects` access used by prepared-logical job creation. */
function modelObjects(
  model: Pick<SurfaceModel, 'objects'>,
): Record<string, SurfaceObjectRecord | undefined> {
  return (model as { objects: Record<string, SurfaceObjectRecord | undefined> })
    .objects;
}

/**
 * True when a rigid translation advanced the background-pack position
 * epoch after the job captured it. Cheap O(records)/O(1) id-keyed reads;
 * never scans samples. Model-less jobs (tests without a model) always
 * report false — their callers rely on geometry/translation checks alone.
 */
function isBackgroundPackPositionStale(job: BackgroundPackInputJob): boolean {
  try {
    const model = job.model;
    if (model === null) return false;
    for (let i = 0; i < job.recordIds.length; i++) {
      const id = job.recordIds[i]!;
      let current = 0;
      try {
        current = recordPositionGeneration(model, id);
      } catch {
        return true;
      }
      if (current !== (job.initialRecordPositions[i] ?? 0)) return true;
    }
    if (job.logicalId !== null) {
      let currentLogical = 0;
      try {
        currentLogical = logicalPositionGeneration(model, job.logicalId);
      } catch {
        return true;
      }
      if (currentLogical !== (job.initialLogicalPosition ?? 0)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** Drop a position-stale input job without installing (disposable cache). */
function dropPositionStaleBackgroundJob(): void {
  activeBackgroundPackJob = null;
  backgroundPackStats.cancelled += 1;
  backgroundPackStats.workerCancelled += 1;
  backgroundPackStats.workerStaleDrops += 1;
  if (backgroundPackQueue.length > 0 || preparedLogicalPackQueue.length > 0)
    scheduleBackgroundPump();
}

/**
 * Async-stale audit:
 *
 * - Single background packing, logical prepared packing, and the ordinary
 *   record-queue logical grouping share ONE job type here and are ALL
 *   covered by the position epoch (capture at creation, recheck before each
 *   input slice, before Worker post, and on Worker response).
 * - Cold compile (`incremental-scene.notifyTranslated`) cancels in-flight
 *   cold jobs for translated ids via `cancelForObjects` and bumps its scene
 *   generation when cached keys shift, so a translated-while-pending cold
 *   result cannot install. Intentionally left on its existing
 *   generation+cancel seam (no position epoch needed).
 * - Reopen hydration (`createLiveCachedCompiledRestore` + derived reopen
 *   store) is revision/dirty gated per attempt; translation marks the
 *   session dirty and never re-triggers a restore, so already-installed
 *   vectors are preserved via derived translation rather than reinstalled.
 *   Intentionally unaffected.
 */

function copyBackgroundInputSlice(
  job: BackgroundPackInputJob,
  budget: number,
): number {
  let copied = 0;
  let global = job.nextSample;
  const total = job.totalSamples;
  // Walk chunks in order, copying at most `budget` samples total.
  // No single slice walks all 100k samples.
  let chunkStart = 0;
  for (
    let ci = 0;
    ci < job.records.length && copied < budget && global < total;
    ci++
  ) {
    const record = job.records[ci]!;
    const pts = (record as Record<string, unknown>).points as
      | unknown[]
      | undefined;
    if (!Array.isArray(pts)) continue;
    const count = pts.length;
    // Skip chunks fully copied.
    if (global >= chunkStart + count) {
      chunkStart += count;
      continue;
    }
    let local = global - chunkStart;
    while (local < count && copied < budget && global < total) {
      const raw = pts[local] as Record<string, unknown> | null | undefined;
      if (raw !== null && raw !== undefined && typeof raw === 'object') {
        const x = raw['x'];
        const y = raw['y'];
        job.positionXY[global * 2] = typeof x === 'number' ? x : 0;
        job.positionXY[global * 2 + 1] = typeof y === 'number' ? y : 0;
        let flags = 0;
        const p = raw['pressure'];
        if (typeof p === 'number' && Number.isFinite(p)) {
          job.pressure[global] = p;
          flags |= 1;
        } else {
          job.pressure[global] = 0;
        }
        const tilt = raw['tilt'] as
          | { x?: unknown; y?: unknown }
          | null
          | undefined;
        if (
          tilt !== null &&
          tilt !== undefined &&
          typeof tilt === 'object' &&
          typeof tilt.x === 'number' &&
          Number.isFinite(tilt.x) &&
          typeof tilt.y === 'number' &&
          Number.isFinite(tilt.y)
        ) {
          job.tiltXY[global * 2] = tilt.x;
          job.tiltXY[global * 2 + 1] = tilt.y;
          flags |= 2;
        } else {
          job.tiltXY[global * 2] = 0;
          job.tiltXY[global * 2 + 1] = 0;
        }
        const tw = raw['twist'];
        if (typeof tw === 'number' && Number.isFinite(tw)) {
          job.twist[global] = tw;
          flags |= 4;
        } else {
          job.twist[global] = 0;
        }
        const d = raw['dt'];
        if (typeof d === 'number' && Number.isFinite(d)) {
          job.dt[global] = d;
          flags |= 8;
        } else {
          job.dt[global] = Number.NaN;
        }
        job.presence[global] = flags;
        // Extras (rare).
        let extra: Record<string, unknown> | undefined;
        for (const key of Object.keys(raw)) {
          if (
            key !== 'x' &&
            key !== 'y' &&
            key !== 'pressure' &&
            key !== 'tilt' &&
            key !== 'twist' &&
            key !== 'dt'
          ) {
            if (extra === undefined) extra = {};
            extra[key] = raw[key];
          }
        }
        if (extra !== undefined) {
          if (job.extras === undefined) {
            job.extras = new Array(total).fill(undefined);
          }
          job.extras[global] = extra;
        }
      } else {
        job.positionXY[global * 2] = 0;
        job.positionXY[global * 2 + 1] = 0;
        job.pressure[global] = 0;
        job.tiltXY[global * 2] = 0;
        job.tiltXY[global * 2 + 1] = 0;
        job.twist[global] = 0;
        job.dt[global] = Number.NaN;
        job.presence[global] = 0;
      }
      local += 1;
      global += 1;
      copied += 1;
    }
    chunkStart += count;
  }
  job.nextSample = global;
  return copied;
}

function ensureBackgroundPackWorker(): BackgroundPackWorker | null {
  if (backgroundPackWorker !== null) return backgroundPackWorker;
  if (backgroundPackWorkerDead) return null;
  if (backgroundPackWorkerFactory === null) return null;
  try {
    const w = backgroundPackWorkerFactory();
    if (w === null || w === undefined) {
      backgroundPackWorkerDead = true;
      return null;
    }
    w.onmessage = (event) => onBackgroundPackWorkerMessage(event.data);
    w.onerror = () => onBackgroundPackWorkerError();
    backgroundPackWorker = w;
    return w;
  } catch {
    backgroundPackWorkerDead = true;
    return null;
  }
}

function onBackgroundPackWorkerMessage(
  response: PackedInkCompileResponse,
): void {
  const pending = activeBackgroundWorkerPending;
  if (pending === null) {
    backgroundPackStats.workerStaleDrops += 1;
    backgroundPackStats.cancelled += 1;
    backgroundPackStats.workerCancelled += 1;
    return;
  }
  if (response.requestId !== pending.requestId) {
    backgroundPackStats.workerStaleDrops += 1;
    backgroundPackStats.cancelled += 1;
    backgroundPackStats.workerCancelled += 1;
    return;
  }
  const job = pending.job;
  activeBackgroundWorkerPending = null;
  if (response.type === 'compile-error') {
    backgroundPackStats.cancelled += 1;
    backgroundPackStats.workerCancelled += 1;
    activeBackgroundPackJob = null;
    if (backgroundPackQueue.length > 0 || preparedLogicalPackQueue.length > 0)
      scheduleBackgroundPump();
    return;
  }
  try {
    const packed = (response as { compiled?: PackedCompiledInk }).compiled;
    if (packed === undefined || packed === null)
      throw new Error('missing packed');
    // Staleness contract (geometry generation + position epoch + identity
    // + translation): install Worker output only when the complete captured
    // state is still current. The explicit mutation epoch is authoritative;
    // count and translation checks remain as cheap defense-in-depth. The
    // position epoch is the ONLY signal for pure rigid translation (which
    // deliberately leaves geometry generations unchanged).
    let stale = false;
    try {
      // Object/logical identity: the response must belong to this job.
      const expectedObjectId =
        job.kind === 'single'
          ? job.recordIds[0]!
          : (job.logicalId ?? job.recordIds[0]!);
      if (response.objectId !== expectedObjectId) stale = true;
      // Worker response generation must echo the meaningful epoch sent.
      if (!stale && response.generation !== job.generation) stale = true;
      if (!stale && job.kind === 'single') {
        const rec = job.records[0]!;
        const recordId = job.recordIds[0]!;
        // All captured geometry generations still current.
        try {
          if (
            (job.model === null
              ? 0
              : recordGeometryGeneration(job.model, recordId)) !==
            job.initialRecordGenerations[0]
          ) {
            stale = true;
          }
        } catch {
          stale = true;
        }
        // Position epoch: rigid translation after capture must drop the
        // response even though geometry generations are unchanged.
        if (!stale && job.model !== null) {
          try {
            if (
              recordPositionGeneration(job.model, recordId) !==
              (job.initialRecordPositions[0] ?? 0)
            ) {
              stale = true;
            }
          } catch {
            stale = true;
          }
        }
        // Record membership/identity when the owning model is known:
        // deletion (missing) or same-id replacement (different object)
        // is stale even if a generation bump was missed.
        if (!stale && job.model !== null) {
          try {
            const current = (
              job.model as {
                objects: Record<string, SurfaceObjectRecord | undefined>;
              }
            ).objects[recordId];
            if (
              current === undefined ||
              current !== (rec as SurfaceObjectRecord)
            ) {
              stale = true;
            }
          } catch {
            stale = true;
          }
        }
        if (!stale && packedCompiledForRecord(rec) !== undefined) stale = true;
        if (!stale && !isCompiledWarm(rec)) stale = true;
        if (!stale && !hasRichCompiledGeometry(rec)) stale = true;
        const pts = (rec as Record<string, unknown>).points;
        const n = Array.isArray(pts) ? pts.length : -1;
        if (!stale && n !== job.initialSampleCounts[0]) stale = true;
        if (!stale) {
          const t = derivedTranslationOfRecord(rec);
          if (t.tx !== job.initialTx || t.ty !== job.initialTy) stale = true;
        }
      } else if (!stale) {
        // Joint: every captured record epoch plus the logical epoch must
        // still be current. A same-length member mutation, pressure/brush
        // edit, deletion, or same-id replacement all advance at least one
        // captured epoch via the invalidation boundary. Rigid translation
        // advances ONLY the position epochs below (geometry deliberately
        // unchanged) — without them a translated-while-pending joint would
        // install stale or mixed-coordinate geometry.
        if (job.logicalId !== null) {
          try {
            if (
              (job.model === null
                ? 0
                : logicalGeometryGeneration(job.model, job.logicalId)) !==
              (job.initialLogicalGeneration ?? 0)
            ) {
              stale = true;
            }
          } catch {
            stale = true;
          }
          if (!stale && job.model !== null) {
            try {
              if (
                logicalPositionGeneration(job.model, job.logicalId) !==
                (job.initialLogicalPosition ?? 0)
              ) {
                stale = true;
              }
            } catch {
              stale = true;
            }
          }
        }
        if (!stale && job.model !== null) {
          for (let i = 0; i < job.records.length; i++) {
            const id = job.recordIds[i]!;
            try {
              if (
                recordPositionGeneration(job.model, id) !==
                (job.initialRecordPositions[i] ?? 0)
              ) {
                stale = true;
                break;
              }
            } catch {
              stale = true;
              break;
            }
          }
        }
        if (!stale) {
          for (let i = 0; i < job.records.length; i++) {
            const id = job.recordIds[i]!;
            try {
              if (
                (job.model === null
                  ? 0
                  : recordGeometryGeneration(job.model, id)) !==
                job.initialRecordGenerations[i]
              ) {
                stale = true;
                break;
              }
            } catch {
              stale = true;
              break;
            }
          }
        }
        // Membership/identity when the owning model is known.
        if (!stale && job.model !== null && job.logicalId !== null) {
          try {
            const objects = (
              job.model as {
                objects: Record<string, SurfaceObjectRecord | undefined>;
              }
            ).objects;
            for (let i = 0; i < job.records.length; i++) {
              const id = job.recordIds[i]!;
              const current = objects[id];
              if (current === undefined || current !== job.records[i]) {
                stale = true;
                break;
              }
              // Chunk must still belong to the same logical stroke.
              let currentLogical: string | null = null;
              try {
                currentLogical = logicalIdOf(current);
              } catch {
                currentLogical = null;
              }
              if (currentLogical !== job.logicalId) {
                stale = true;
                break;
              }
            }
          } catch {
            stale = true;
          }
        }
        if (!stale && job.model === null && job.logicalId !== null) {
          // Without a model, still verify the captured references belong
          // to the expected logical (catches programming errors where the
          // queue grouped mismatched chunks).
          try {
            for (const r of job.records) {
              if (logicalIdOf(r) !== job.logicalId) {
                stale = true;
                break;
              }
            }
          } catch {
            stale = true;
          }
        }
        // Joint: all chunks must still carry no newer joint? Actually joint
        // may already exist (from cold lane) — if any chunk already has a
        // joint packed different from what we started with, drop. For
        // simplicity: if first chunk already has joint packed, drop as stale
        // (cold lane won). Also verify sample counts and joint translation.
        const first = job.records[0]!;
        const existing = (() => {
          try {
            return jointPackedForChunk(first);
          } catch {
            return undefined;
          }
        })();
        if (!stale && existing !== undefined) stale = true;
        if (!stale) {
          for (let i = 0; i < job.records.length; i++) {
            const r = job.records[i]!;
            const pts = (r as Record<string, unknown>).points;
            const n = Array.isArray(pts) ? pts.length : -1;
            if (n !== job.initialSampleCounts[i]) {
              stale = true;
              break;
            }
          }
        }
        if (!stale && job.records.length > 0) {
          try {
            const jt = jointTranslationForChunk(job.records[0]!);
            if (jt.tx !== job.initialJointTx || jt.ty !== job.initialJointTy)
              stale = true;
          } catch {
            // Ignore.
          }
        }
      }
    } catch {
      stale = true;
    }
    if (stale) {
      backgroundPackStats.workerStaleDrops += 1;
      backgroundPackStats.cancelled += 1;
      backgroundPackStats.workerCancelled += 1;
      activeBackgroundPackJob = null;
      if (backgroundPackQueue.length > 0 || preparedLogicalPackQueue.length > 0)
        scheduleBackgroundPump();
      return;
    }
    // Install: single → retainPackedForRecord; joint → retainJointPackedForChunks.
    try {
      if (job.kind === 'single') {
        retainPackedForRecord(job.records[0]!, packed);
      } else {
        retainJointPackedForChunks([...job.records], packed);
      }
      backgroundPackStats.completed += 1;
      backgroundPackStats.workerCompleted += 1;
      try {
        const outBytes = packedCompiledByteLength(packed);
        backgroundPackStats.bytes += outBytes;
        backgroundPackStats.outputBytes += outBytes;
      } catch {
        // Ignore.
      }
    } catch {
      backgroundPackStats.cancelled += 1;
      backgroundPackStats.workerCancelled += 1;
    } finally {
      activeBackgroundPackJob = null;
    }
  } catch {
    backgroundPackStats.cancelled += 1;
    backgroundPackStats.workerCancelled += 1;
    activeBackgroundPackJob = null;
  }
  if (backgroundPackQueue.length > 0 || preparedLogicalPackQueue.length > 0)
    scheduleBackgroundPump();
}

function onBackgroundPackWorkerError(): void {
  try {
    backgroundPackWorker?.terminate();
  } catch {
    // Ignore.
  }
  backgroundPackWorker = null;
  backgroundPackWorkerDead = true;
  // Active Worker-pending job is dropped (SKIP, never main-thread fallback).
  if (activeBackgroundWorkerPending !== null) {
    activeBackgroundWorkerPending = null;
    backgroundPackStats.cancelled += 1;
    backgroundPackStats.workerCancelled += 1;
  }
  if (activeBackgroundPackJob !== null) {
    // Input-prep job without Worker: discard (SKIP).
    activeBackgroundPackJob = null;
    backgroundPackStats.cancelled += 1;
    backgroundPackStats.workerCancelled += 1;
  }
  // Drain queue as skipped (disposable cache).
  while (backgroundPackQueue.length > 0) {
    backgroundPackQueue.shift();
    backgroundPackStats.cancelled += 1;
    backgroundPackStats.workerCancelled += 1;
  }
  preparedLogicalPackQueue.length = 0;
}

function pumpBackgroundPackQueue(deadline?: { timeRemaining(): number }): void {
  backgroundPackScheduled = false;
  // If a Worker response is in flight, wait (one lane, low priority).
  if (activeBackgroundWorkerPending !== null) return;
  const budget = BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE;
  try {
    if (activeBackgroundPackJob === null) {
      // Scene-prepared logical units first: one joint Worker job per
      // committed logical whose rendered/compiled joint the scene
      // acknowledged, without requiring per-chunk rich geometry.
      while (preparedLogicalPackQueue.length > 0) {
        const request = preparedLogicalPackQueue.shift()!;
        const preparedJob = createPreparedLogicalJob(request);
        if (preparedJob === null) {
          backgroundPackStats.cancelled += 1;
          backgroundPackStats.workerCancelled += 1;
          continue;
        }
        activeBackgroundPackJob = preparedJob;
        backgroundPackStats.started += 1;
        break;
      }
      // Start next record job: skip stale heads without burning a slice.
      while (
        activeBackgroundPackJob === null &&
        backgroundPackQueue.length > 0
      ) {
        const head = backgroundPackQueue[0]!;
        try {
          // Already packed → skip (never repack).
          if (packedCompiledForRecord(head) !== undefined) {
            backgroundPackQueue.shift();
            backgroundPackStats.cancelled += 1;
            backgroundPackStats.workerCancelled += 1;
            continue;
          }
          // Joint already present → skip (joint covers persistence).
          try {
            if (jointPackedForChunk(head) !== undefined) {
              backgroundPackQueue.shift();
              backgroundPackStats.cancelled += 1;
              backgroundPackStats.workerCancelled += 1;
              continue;
            }
          } catch {
            // Ignore.
          }
          if (!isCompiledWarm(head)) {
            backgroundPackQueue.shift();
            backgroundPackStats.cancelled += 1;
            backgroundPackStats.workerCancelled += 1;
            continue;
          }
          if (!hasRichCompiledGeometry(head)) {
            backgroundPackQueue.shift();
            backgroundPackStats.cancelled += 1;
            backgroundPackStats.workerCancelled += 1;
            continue;
          }
          // Group logical peers among queued heads: if head belongs to a
          // logical, gather all queued chunks of that logical for a JOINT
          // input job (bounded grouping, no full-model scan).
          let logical: string | null = null;
          try {
            logical = logicalIdOf(head);
          } catch {
            logical = null;
          }
          if (logical === null) {
            const job = createBackgroundInputJob(
              [head],
              null,
              backgroundPackModelFor(head),
            );
            if (job === null) {
              backgroundPackQueue.shift();
              backgroundPackStats.cancelled += 1;
              backgroundPackStats.workerCancelled += 1;
              continue;
            }
            backgroundPackQueue.shift();
            activeBackgroundPackJob = job;
            backgroundPackStats.started += 1;
            break;
          } else {
            // Collect queued records only from the same model + logical.
            // Identical logical ids in concurrently open documents are
            // unrelated jobs and must never share one packed identity.
            const headModel = backgroundPackModelFor(head);
            const peers: SurfaceObjectRecord[] = [];
            const remaining: SurfaceObjectRecord[] = [];
            for (const r of backgroundPackQueue) {
              try {
                if (
                  backgroundPackModelFor(r) === headModel &&
                  logicalIdOf(r) === logical
                )
                  peers.push(r);
                else remaining.push(r);
              } catch {
                remaining.push(r);
              }
            }
            // Sort peers by chunkIndex (head first) for deterministic joint.
            try {
              peers.sort((a, b) => {
                const ai = chunkIndexOf(a);
                const bi = chunkIndexOf(b);
                if (ai !== null && bi !== null) return ai - bi;
                return 0;
              });
            } catch {
              // Keep queue order on failure.
            }
            const job = createBackgroundInputJob(peers, logical, headModel);
            if (job === null) {
              // Drop all peers as skipped.
              backgroundPackQueue.length = 0;
              backgroundPackQueue.push(...remaining);
              backgroundPackStats.cancelled += peers.length;
              backgroundPackStats.workerCancelled += peers.length;
              continue;
            }
            backgroundPackQueue.length = 0;
            backgroundPackQueue.push(...remaining);
            activeBackgroundPackJob = job;
            backgroundPackStats.started += 1;
            break;
          }
        } catch {
          try {
            backgroundPackQueue.shift();
          } catch {
            // Ignore.
          }
          backgroundPackStats.cancelled += 1;
          backgroundPackStats.workerCancelled += 1;
        }
      }
      if (activeBackgroundPackJob === null) return;
    }
    const job = activeBackgroundPackJob;
    // Position-epoch recheck BEFORE starting/resuming an input-copy slice:
    // a rigid translation between slices advances ONLY the position epoch
    // (geometry deliberately unchanged). Never copy/post/install from a
    // different canonical position — drop the partially copied job. The
    // current scene/rendering remains authoritative; a later prepare/commit
    // may schedule a fresh pack. Never repair typed arrays in place and
    // never restart synchronously inside the translation handler.
    try {
      if (isBackgroundPackPositionStale(job)) {
        dropPositionStaleBackgroundJob();
        return;
      }
    } catch {
      dropPositionStaleBackgroundJob();
      return;
    }
    // Staleness recheck before burning slice work.
    try {
      if (job.kind === 'single') {
        const rec = job.records[0]!;
        if (packedCompiledForRecord(rec) !== undefined) {
          activeBackgroundPackJob = null;
          backgroundPackStats.cancelled += 1;
          backgroundPackStats.workerCancelled += 1;
          if (
            backgroundPackQueue.length > 0 ||
            preparedLogicalPackQueue.length > 0
          )
            scheduleBackgroundPump();
          return;
        }
        if (!isCompiledWarm(rec) || !hasRichCompiledGeometry(rec)) {
          activeBackgroundPackJob = null;
          backgroundPackStats.cancelled += 1;
          backgroundPackStats.workerCancelled += 1;
          if (
            backgroundPackQueue.length > 0 ||
            preparedLogicalPackQueue.length > 0
          )
            scheduleBackgroundPump();
          return;
        }
      } else {
        // Joint: if any peer already has joint (cold lane won), cancel.
        try {
          if (jointPackedForChunk(job.records[0]!) !== undefined) {
            activeBackgroundPackJob = null;
            backgroundPackStats.cancelled += 1;
            backgroundPackStats.workerCancelled += 1;
            if (
              backgroundPackQueue.length > 0 ||
              preparedLogicalPackQueue.length > 0
            )
              scheduleBackgroundPump();
            return;
          }
        } catch {
          // Ignore.
        }
      }
    } catch {
      activeBackgroundPackJob = null;
      backgroundPackStats.cancelled += 1;
      backgroundPackStats.workerCancelled += 1;
      if (backgroundPackQueue.length > 0 || preparedLogicalPackQueue.length > 0)
        scheduleBackgroundPump();
      return;
    }
    const timeLeft = (): number => {
      try {
        if (
          deadline !== undefined &&
          typeof deadline.timeRemaining === 'function'
        ) {
          return deadline.timeRemaining();
        }
      } catch {
        // Ignore.
      }
      return Infinity;
    };
    // One bounded input slice: at most `budget` canonical samples copied.
    let copied = 0;
    try {
      copied = copyBackgroundInputSlice(job, budget);
    } catch {
      activeBackgroundPackJob = null;
      backgroundPackStats.cancelled += 1;
      backgroundPackStats.workerCancelled += 1;
      if (backgroundPackQueue.length > 0 || preparedLogicalPackQueue.length > 0)
        scheduleBackgroundPump();
      return;
    }
    backgroundPackStats.mainThreadChunks += 1;
    backgroundPackStats.inputChunks += 1;
    backgroundPackStats.inputSamples += copied;
    if (copied > backgroundPackStats.maxMainThreadPackChunkItems) {
      backgroundPackStats.maxMainThreadPackChunkItems = copied;
    }
    if (copied > backgroundPackStats.maxInputSamplesPerSlice) {
      backgroundPackStats.maxInputSamplesPerSlice = copied;
    }
    if (timeLeft() < 1 && job.nextSample < job.totalSamples) {
      scheduleBackgroundPump();
      return;
    }
    if (job.nextSample < job.totalSamples) {
      scheduleBackgroundPump();
      return;
    }
    // Position-epoch recheck BEFORE posting the completed input to the
    // Worker: translation may have landed after the final copy slice but
    // before the post. Never let mixed/old-coordinate input reach the
    // Worker.
    try {
      if (isBackgroundPackPositionStale(job)) {
        dropPositionStaleBackgroundJob();
        return;
      }
    } catch {
      dropPositionStaleBackgroundJob();
      return;
    }
    // Input complete: post to Worker (transferable buffers, no main-thread compile).
    const worker = ensureBackgroundPackWorker();
    if (worker === null) {
      // No Worker in production: SKIP (disposable cache, never fallback).
      activeBackgroundPackJob = null;
      backgroundPackStats.cancelled += 1;
      backgroundPackStats.workerCancelled += 1;
      if (backgroundPackQueue.length > 0 || preparedLogicalPackQueue.length > 0)
        scheduleBackgroundPump();
      return;
    }
    try {
      backgroundPackRequestCounter += 1;
      const requestId = `bgpack-${backgroundPackRequestCounter}`;
      const packedSamples: PackedInkSamples = {
        version: 1,
        count: job.totalSamples,
        positionXY: job.positionXY,
        pressure: job.pressure,
        tiltXY: job.tiltXY,
        twist: job.twist,
        dt: job.dt,
        presence: job.presence,
        ...(job.extras !== undefined ? { extras: job.extras } : {}),
      };
      const inputBytes = job.inputBytes;
      const request: PackedInkCompileRequest = {
        type: 'compile-ink',
        requestId,
        objectId:
          job.kind === 'single'
            ? job.recordIds[0]!
            : (job.logicalId ?? job.recordIds[0]!),
        generation: job.generation,
        samples: packedSamples,
        brush: { ...job.brush } as InkBrushSpec,
        packMs: 0,
        inputBytes,
      };
      let transfer: readonly ArrayBuffer[] = [];
      try {
        transfer = packedSamplesTransfer(packedSamples);
      } catch {
        transfer = [];
      }
      backgroundPackStats.inputBytes += inputBytes;
      backgroundPackStats.workerJobs += 1;
      activeBackgroundWorkerPending = { requestId, job };
      try {
        worker.postMessage(request, transfer as ArrayBuffer[]);
      } catch {
        // Post failed: SKIP (never fallback).
        activeBackgroundWorkerPending = null;
        activeBackgroundPackJob = null;
        backgroundPackStats.cancelled += 1;
        backgroundPackStats.workerCancelled += 1;
        if (
          backgroundPackQueue.length > 0 ||
          preparedLogicalPackQueue.length > 0
        )
          scheduleBackgroundPump();
        return;
      }
      // Wait for Worker response; input buffers transferred (job keeps
      // references but must not touch them after transfer).
    } catch {
      activeBackgroundPackJob = null;
      backgroundPackStats.cancelled += 1;
      backgroundPackStats.workerCancelled += 1;
      if (backgroundPackQueue.length > 0 || preparedLogicalPackQueue.length > 0)
        scheduleBackgroundPump();
      return;
    }
  } finally {
    // Pump never throws.
  }
  // While Worker is pending, no further pumping until response.
}

function scheduleBackgroundPump(): void {
  if (backgroundPackScheduled) return;
  backgroundPackScheduled = true;
  try {
    const ric = (
      globalThis as unknown as {
        requestIdleCallback?: (
          cb: (deadline: { timeRemaining(): number }) => void,
          opts?: { timeout: number },
        ) => void;
      }
    ).requestIdleCallback;
    if (typeof ric === 'function') {
      ric((deadline) => pumpBackgroundPackQueue(deadline), { timeout: 100 });
      return;
    }
  } catch {
    // Fall through.
  }
  try {
    const timer = (
      globalThis as unknown as {
        setTimeout?: (cb: () => void, ms: number) => void;
      }
    ).setTimeout;
    if (typeof timer === 'function') {
      timer(() => pumpBackgroundPackQueue(), 0);
    } else {
      backgroundPackScheduled = false;
    }
  } catch {
    backgroundPackScheduled = false;
  }
}

/**
 * Queue low-priority background packing for live-committed records.
 * Call after commit (not teardown); teardown never calls this.
 *
 * FINAL §4: bounded sliced canonical-input COPY (≤2000 samples per slice)
 * → transferable typed arrays → low-priority Worker (same canonical
 * compiler + pack) → stale-safe retention. Destination buffer allocation is
 * a measured one-shot O(N) init (see the lane comment), not covered by the
 * per-slice copy budget. If no Worker is available or it fails, the record
 * is SKIPPED (disposable cache) — never a giant main-thread fallback.
 * `backgroundPackStats.mainThreadFullPacks` stays 0.
 */
export function scheduleBackgroundPackForRecords(
  records: readonly SurfaceObjectRecord[],
  model?: Pick<SurfaceModel, 'objects'>,
): void {
  for (const record of records) {
    try {
      queueBackgroundPackRecord(record, model ?? null);
    } catch {
      // Never breaks commit.
    }
  }
  if (
    backgroundPackQueue.length > 0 ||
    preparedLogicalPackQueue.length > 0 ||
    activeBackgroundPackJob !== null
  ) {
    scheduleBackgroundPump();
  }
}

/**
 * Queue ONE live-committed canonical record for background packing.
 * Returns true when the record is queued or already covered (retained
 * packed/joint); false when it is not yet rich-warm (callers holding a
 * commit/prepared rendezvous must keep their marker for a later retry).
 */
function queueBackgroundPackRecord(
  record: SurfaceObjectRecord,
  model: Pick<SurfaceModel, 'objects'> | null,
): boolean {
  if (packedCompiledForRecord(record) !== undefined) return true;
  // Joint already present → persistence covered, skip.
  try {
    if (jointPackedForChunk(record) !== undefined) return true;
  } catch {
    // Ignore.
  }
  if (!isCompiledWarm(record)) return false;
  if (!hasRichCompiledGeometry(record)) return false;
  if (backgroundPackQueue.includes(record)) return true;
  if (activeBackgroundPackJob?.records.includes(record)) return true;
  backgroundPackQueue.push(record);
  if (model !== null) {
    try {
      backgroundPackModelByRecord.set(record as object, model);
    } catch {
      // Model tracking never breaks commit.
    }
  }
  backgroundPackStats.queued += 1;
  backgroundPackStats.jobsQueued += 1;
  return true;
}

/**
 * Queue one scene-prepared unit for background packing (commit/prepared
 * rendezvous consumer).
 *
 * - `single`: the ordinary per-record path (requires rich-warm/packed).
 * - `logical`: one joint Worker compile/pack request over the CURRENT
 *   canonical members, in canonical `chunkIndex` order. Individual chunks
 *   are NOT required to own rich compiled geometry: the committed scene
 *   proved the logical joint prepared. Members are re-resolved/revalidated
 *   at job creation and on Worker completion (identity + generations), so
 *   deletion/replacement/membership changes reject stale work.
 *
 * Returns true when the unit is queued or already covered; false when it
 * could not be scheduled (single not warm yet, or logical membership
 * invalid). Callers must not clear rendezvous state on false.
 */
export function scheduleBackgroundPackForPreparedUnit(
  unit: PreparedBackgroundPackUnit,
  model?: Pick<SurfaceModel, 'objects'>,
): boolean {
  try {
    if (unit.kind === 'single') {
      return queueBackgroundPackRecord(unit.record, model ?? null);
    }
    const queued = queuePreparedLogicalUnit(unit, model ?? null);
    if (queued) {
      if (
        backgroundPackQueue.length > 0 ||
        preparedLogicalPackQueue.length > 0 ||
        activeBackgroundPackJob !== null
      ) {
        scheduleBackgroundPump();
      }
    }
    return queued;
  } catch {
    return false;
  }
}

function queuePreparedLogicalUnit(
  unit: Extract<PreparedBackgroundPackUnit, { kind: 'logical' }>,
  model: Pick<SurfaceModel, 'objects'> | null,
): boolean {
  const records = unit.records;
  if (records.length === 0) return false;
  // Already retained on any member → persistence covered. (All members
  // share one joint reference by construction.)
  for (const record of records) {
    try {
      if (jointPackedForChunk(record) !== undefined) return true;
    } catch {
      // Probing never breaks scheduling.
    }
  }
  let logicalGeneration: number | null = null;
  let logicalPosition: number | null = null;
  if (model !== null) {
    try {
      logicalGeneration = logicalGeometryGeneration(model, unit.logicalId);
    } catch {
      logicalGeneration = null;
    }
    try {
      logicalPosition = logicalPositionGeneration(model, unit.logicalId);
    } catch {
      logicalPosition = null;
    }
  }
  const request: PreparedLogicalPackRequest = {
    logicalId: unit.logicalId,
    ids: records.map((record) => record.id),
    records: [...records],
    model,
    logicalGeneration,
    logicalPosition,
  };
  // Reconcile an already-queued/active request for the same (model,
  // logical): the newest prepared truth must never be dropped behind a
  // stale snapshot. A queued request is REFRESHED in place; an active job
  // whose captured epoch is still current already covers this unit, while
  // an epoch-advanced active job will drop stale and a refreshed request
  // queues behind it.
  try {
    if (
      activeBackgroundPackJob !== null &&
      activeBackgroundPackJob.logicalId === unit.logicalId &&
      activeBackgroundPackJob.model === model &&
      activeBackgroundPackJob.generation === (logicalGeneration ?? 0) &&
      (activeBackgroundPackJob.initialLogicalPosition ?? 0) ===
        (logicalPosition ?? 0)
    ) {
      return true;
    }
    for (let i = 0; i < preparedLogicalPackQueue.length; i++) {
      const queuedRequest = preparedLogicalPackQueue[i]!;
      if (
        queuedRequest.logicalId === unit.logicalId &&
        queuedRequest.model === model
      ) {
        preparedLogicalPackQueue[i] = request;
        return true;
      }
    }
  } catch {
    // Reconcile never breaks scheduling.
  }
  preparedLogicalPackQueue.push(request);
  backgroundPackStats.queued += records.length;
  backgroundPackStats.jobsQueued += 1;
  return true;
}

/** Inject the low-priority Worker factory for background packing (production host wires a module Worker; tests inject fakes). */
export function setBackgroundPackWorkerFactory(
  factory: (() => BackgroundPackWorker | null) | null,
): void {
  backgroundPackWorkerFactory = factory;
  backgroundPackWorkerDead = false;
  try {
    backgroundPackWorker?.terminate();
  } catch {
    // Ignore.
  }
  backgroundPackWorker = null;
}

/** Test seam: drain queued background packing (bounded input slices + Worker responses). */
export async function flushBackgroundPackQueueForTests(
  maxSlices = 10000,
): Promise<void> {
  for (let i = 0; i < maxSlices; i++) {
    if (
      backgroundPackQueue.length === 0 &&
      preparedLogicalPackQueue.length === 0 &&
      activeBackgroundPackJob === null &&
      activeBackgroundWorkerPending === null
    ) {
      return;
    }
    // If Worker is pending, yield for its microtask response first.
    if (activeBackgroundWorkerPending !== null) {
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        try {
          const st = (
            globalThis as unknown as {
              setTimeout?: (cb: () => void, ms: number) => unknown;
            }
          ).setTimeout;
          if (typeof st === 'function') st(() => resolve(), 0);
          else resolve();
        } catch {
          resolve();
        }
      });
      // If still pending after yields (real Worker), continue pumping input
      // for other jobs? Single lane waits; just continue to allow timeout.
      if (
        activeBackgroundWorkerPending !== null &&
        backgroundPackQueue.length === 0 &&
        preparedLogicalPackQueue.length === 0 &&
        activeBackgroundPackJob !== null
      ) {
        // Input job waiting for Worker that never responds in tests without
        // Worker: pump will SKIP it on next slice (no Worker → cancel).
        // Force a pump to make progress.
        pumpBackgroundPackQueue();
        await Promise.resolve();
      }
      continue;
    }
    pumpBackgroundPackQueue();
    await Promise.resolve();
  }
}

/** Test seam: reset background packing state (queues, active job, Worker, stats). */
export function resetBackgroundPackForTests(): void {
  backgroundPackQueue.length = 0;
  preparedLogicalPackQueue.length = 0;
  backgroundPackModelByRecord = new WeakMap();
  activeBackgroundPackJob = null;
  activeBackgroundWorkerPending = null;
  backgroundPackScheduled = false;
  backgroundPackStats.queued = 0;
  backgroundPackStats.started = 0;
  backgroundPackStats.completed = 0;
  backgroundPackStats.cancelled = 0;
  backgroundPackStats.fallbackJobs = 0;
  backgroundPackStats.workerJobs = 0;
  backgroundPackStats.bytes = 0;
  backgroundPackStats.mainThreadChunks = 0;
  backgroundPackStats.maxMainThreadPackChunkItems = 0;
  backgroundPackStats.jobsQueued = 0;
  backgroundPackStats.inputChunks = 0;
  backgroundPackStats.inputSamples = 0;
  backgroundPackStats.workerCompleted = 0;
  backgroundPackStats.workerCancelled = 0;
  backgroundPackStats.workerStaleDrops = 0;
  backgroundPackStats.inputBytes = 0;
  backgroundPackStats.outputBytes = 0;
  backgroundPackStats.mainThreadFullPacks = 0;
  backgroundPackStats.maxInputSamplesPerSlice = 0;
  try {
    backgroundPackWorker?.terminate();
  } catch {
    // Ignore.
  }
  backgroundPackWorker = null;
  backgroundPackWorkerDead = false;
  backgroundPackWorkerFactory = null;
  backgroundPackRequestCounter = 0;
}

/** Teardown helper: drop pending background work without installing (route-switch/close). */
export function cancelBackgroundPackForTests(): void {
  backgroundPackQueue.length = 0;
  preparedLogicalPackQueue.length = 0;
  if (
    activeBackgroundPackJob !== null ||
    activeBackgroundWorkerPending !== null
  ) {
    backgroundPackStats.cancelled += 1;
    backgroundPackStats.workerCancelled += 1;
  }
  activeBackgroundPackJob = null;
  activeBackgroundWorkerPending = null;
  backgroundPackScheduled = false;
}

/**
 * Focused diagnostic for one-shot O(N) background-input initialization:
 * isolate `createBackgroundInputJob()` typed-array allocation and
 * zero-initialization from bounded sliced copying and Worker
 * compilation. The allocation is size-dependent (6 buffers: Float64×2,
 * Float32×3, Float64×1, Uint8×1) while copying is bounded to
 * ≤2000 samples/slice. Callers (notably the real-Chromium bench) record
 * `initMs` separately — never folded into another bucket.
 */
export interface BackgroundInputInitTiming {
  readonly totalSamples: number;
  /** One-shot buffer allocation/zero-init ms (the measured remaining O(N)). */
  readonly initMs: number;
  /** Bounded sliced canonical copying ms (≤2000 samples/slice). */
  readonly copyMs: number;
  readonly copySlices: number;
  readonly maxSliceSamples: number;
  readonly inputBytes: number;
}

function backgroundNow(): number {
  try {
    const perf = (globalThis as unknown as { performance?: { now(): number } })
      .performance;
    if (perf !== undefined && typeof perf.now === 'function') return perf.now();
  } catch {
    // Fall through.
  }
  return Date.now();
}

/**
 * Time background-input job initialization separately from sliced copying.
 * Returns null when the records carry no samples or exceed the 500k cap
 * (same guards as the production lane). Never throws; never touches the
 * queue, Worker, or stats.
 */
export function timeBackgroundInputInit(
  records: readonly SurfaceObjectRecord[],
  logicalId: string | null = null,
): BackgroundInputInitTiming | null {
  try {
    const t0 = backgroundNow();
    const job = createBackgroundInputJob(records, logicalId, null);
    const t1 = backgroundNow();
    if (job === null) return null;
    const initMs = t1 - t0;
    const totalSamples = job.totalSamples;
    const inputBytes = job.inputBytes;
    const c0 = backgroundNow();
    let slices = 0;
    let maxSlice = 0;
    try {
      for (;;) {
        if (job.nextSample >= job.totalSamples) break;
        const copied = copyBackgroundInputSlice(
          job,
          BACKGROUND_PACK_INPUT_SAMPLES_PER_SLICE,
        );
        slices += 1;
        if (copied > maxSlice) maxSlice = copied;
        if (copied <= 0) break;
        // Safety cap: production jobs never exceed 500k/2000 = 250 slices.
        if (slices > 1000) break;
      }
    } catch {
      return null;
    }
    const c1 = backgroundNow();
    return {
      totalSamples,
      initMs,
      copyMs: c1 - c0,
      copySlices: slices,
      maxSliceSamples: maxSlice,
      inputBytes,
    };
  } catch {
    return null;
  }
}

/** The store fields one persistence pass needs (no model reference). */
type PersistTarget = Pick<
  RestoreCompiledInput,
  'documentId' | 'revision' | 'cache'
>;

/** Pack one warm record into the cache (rebased to world coordinates). */
function persistWarmRecord(
  input: PersistTarget,
  record: SurfaceObjectRecord,
): boolean {
  try {
    const packed = worldPackedForRecord(record);
    if (packed === undefined) return false;
    input.cache.storeCompiled(
      derivedCacheKey(input.documentId, record.id, input.revision),
      packed,
    );
    return true;
  } catch {
    // Cache writes never break teardown.
    return false;
  }
}

/**
 * Persist viewport-warm compiled geometry for the next open (reopen
 * store path): packs records whose geometry is already compiled
 * (viewport-prepared, Worker-hydrated) WITHOUT compiling anything new.
 * Compiled geometry is immutable LOCAL geometry plus an accumulated
 * derived translation; the packed copy is rebased into world coordinates
 * so a restored record lands exactly where the canonical samples say —
 * never recompiled, never persisted at a stale world position. When a
 * record retains the packed copy produced by the Worker/cache restore,
 * that representation is reused (XY-only rebase at most) instead of
 * unpacking and repacking an identical object graph.
 *
 * Bounded by the cache's compiled-slot budgets (bytes + count): only the
 * last entries that fit are packed (the cache would evict the rest
 * anyway), so teardown work and the durable payload stay bounded no
 * matter how many strokes the viewport warmed. Never throws.
 */
export function persistWarmCompiledGeometry(
  input: RestoreCompiledInput,
): PersistCompiledStats {
  const stats: PersistCompiledStats = { stores: 0 };
  const warm = collectWarmRecords(input.model);
  for (const record of warm.slice(-DERIVED_CACHE_MAX_COMPILED)) {
    if (persistWarmRecord(input, record)) stats.stores += 1;
  }
  return stats;
}

export interface PersistCompiledAsyncOptions {
  /** Cooperative yield between packing batches (default: macrotask). */
  readonly yieldFn?: () => Promise<void>;
  /** Warm records packed per batch before yielding. */
  readonly batchSize?: number;
}

/**
 * Cooperative-yield twin of `persistWarmCompiledGeometry` for editor
 * teardown: yields once before packing (so the interaction that closed the
 * editor gets a frame) and again between bounded batches, keeping the
 * main thread responsive while a large warm cache is serialized.
 */
export async function persistWarmCompiledGeometryAsync(
  input: RestoreCompiledInput,
  options: PersistCompiledAsyncOptions = {},
): Promise<PersistCompiledStats> {
  return persistWarmCompiledRecordsAsync(
    {
      documentId: input.documentId,
      revision: input.revision,
      cache: input.cache,
      records: collectWarmRecords(input.model),
    },
    options,
  );
}

/**
 * Warm-records variant used by the store's queued job: the job captures
 * the warm-record snapshot at schedule time, so it never retains the
 * mutable session/model while waiting on the persistence lane.
 */
export async function persistWarmCompiledRecordsAsync(
  input: {
    readonly documentId: string;
    readonly revision: string;
    readonly cache: SurfaceDerivedCache;
    readonly records: readonly SurfaceObjectRecord[];
  },
  options: PersistCompiledAsyncOptions = {},
): Promise<PersistCompiledStats> {
  const yieldFn = options.yieldFn ?? yieldToEventLoop;
  const batchSize =
    typeof options.batchSize === 'number' && options.batchSize > 0
      ? Math.floor(options.batchSize)
      : 128;
  const stats: PersistCompiledStats = { stores: 0 };
  await yieldFn();
  const bounded = input.records.slice(-DERIVED_CACHE_MAX_COMPILED);
  let sinceYield = 0;
  for (const record of bounded) {
    if (
      persistWarmRecord(
        {
          documentId: input.documentId,
          revision: input.revision,
          cache: input.cache,
        },
        record,
      )
    ) {
      stats.stores += 1;
    }
    sinceYield += 1;
    if (sinceYield >= batchSize) {
      sinceYield = 0;
      await yieldFn();
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Off-main-thread persistence packing
// ---------------------------------------------------------------------------

/**
 * One compiled entry for an off-thread persistence pass. `packed` is
 * LOCAL geometry; the worker applies `(tx, ty)` (the record's accumulated
 * derived translation) to land on world coordinates. `transfer` marks
 * packed buffers the caller exclusively owns and will not use again — the
 * worker may take ownership instead of copying.
 */
export interface DerivedCachePackEntry {
  readonly key: DerivedCacheKey;
  readonly packed: PackedCompiledInk;
  readonly tx: number;
  readonly ty: number;
  readonly transfer: boolean;
}

export interface DerivedCachePackRequest {
  readonly documentId: string;
  readonly revision: string;
  readonly bounds: readonly CachedDerivedBounds[];
  readonly compiled: readonly DerivedCachePackEntry[];
}

/**
 * Off-main-thread persistence packer (reuses the Ink/background Worker
 * infrastructure). Receives warm packed geometry plus bounds, performs
 * world-coordinate rebase and binary container construction away from the
 * UI thread, and resolves the container bytes. Implementations must never
 * throw across the boundary; the store falls back to the cooperative
 * main-thread packer on failure.
 */
export interface DerivedCachePacker {
  pack(request: DerivedCachePackRequest): Promise<Uint8Array>;
  /**
   * Truly-lazy manifest + per-entry packing (closure pass, optional).
   * Rebases retained packed entries to world coordinates, encodes each as
   * a standalone binary record, and builds the lightweight manifest/index
   * — all off the UI thread. Returns manifest bytes + per-entry binaries
   * for the store to save via the byte-store port (manifest at
   * `documentId`, entries at `derivedCacheEntryStorageKey`). Absent means
   * the store falls back to the cooperative main-thread lazy packer.
   */
  packLazy?(request: DerivedCachePackRequest): Promise<{
    manifest: Uint8Array;
    entries: { objectId: string; bytes: Uint8Array }[];
  }>;
}

/**
 * Collect the compiled entries for one document/revision, using ONLY the
 * record's retained packed copy (never packing identical geometry) and
 * filling in cache-only entries (objects never prepared this session)
 * from the cache. Bounded by the cache byte budget and entry ceiling so
 * the durable payload can never exceed the cache budget.
 *
 * Closure-pass ownership: teardown gathers ONLY already-packed entries.
 * Records without a retained packed copy (live strokes whose background
 * packing has not finished) are SKIPPED — never synchronously packed.
 * The cache is disposable; UI responsiveness beats completeness.
 */
export function collectPersistEntries(input: {
  readonly documentId: string;
  readonly revision: string;
  readonly warm: readonly SurfaceObjectRecord[];
  readonly cache: SurfaceDerivedCache;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
}): DerivedCachePackEntry[] {
  const maxBytes = input.maxBytes ?? DERIVED_CACHE_MAX_COMPILED_BYTES;
  const maxEntries = input.maxEntries ?? DERIVED_CACHE_MAX_COMPILED;
  const out: DerivedCachePackEntry[] = [];
  const covered = new Set<string>();
  let bytes = 0;
  const push = (entry: DerivedCachePackEntry): void => {
    const entryBytes = packedCompiledByteLength(entry.packed);
    if (out.length >= maxEntries) return;
    if (bytes + entryBytes > maxBytes) return;
    bytes += entryBytes;
    covered.add(entry.key.objectId);
    out.push(entry);
  };
  // Warm records first (topmost paint order wins within the budget). The
  // budget defines a deterministic prefix: once an entry no longer fits,
  // packing stops — the remaining document is never packed just to be
  // discarded (bounded teardown work). Only retained packed copies are
  // gathered; unpacked live records are skipped (background packing will
  // retain them for a later teardown).
  for (const record of input.warm) {
    if (out.length >= maxEntries || bytes >= maxBytes) break;
    try {
      const retained = packedCompiledForRecord(record);
      if (retained === undefined) continue;
      const { tx, ty } = derivedTranslationOfRecord(record);
      const entry: DerivedCachePackEntry = {
        key: derivedCacheKey(input.documentId, record.id, input.revision),
        packed: retained,
        tx,
        ty,
        transfer: false,
      };
      if (bytes + packedCompiledByteLength(entry.packed) > maxBytes) break;
      push(entry);
    } catch {
      // Skip only that record.
    }
  }
  // Joint logical strokes (one stable packed entry per logical id, never one
  // per chunk). Warm joint chunks carry the same joint reference on every
  // peer; dedupe by logical id and rebase by the JOINT translation owned by
  // the packed identity (FINAL §2.3) — never by whichever chunk happens to
  // be encountered first. Per-record retained geometry must not contaminate
  // the joint transform. Content mutation clears joint retention (see
  // `invalidateCompiledForIds`), so edited logicals naturally miss here and
  // recompile safely.
  try {
    const seenLogicals = new Set<string>();
    for (const record of input.warm) {
      if (out.length >= maxEntries || bytes >= maxBytes) break;
      let logical: string | null = null;
      try {
        logical = logicalIdOf(record);
      } catch {
        continue;
      }
      if (logical === null || seenLogicals.has(logical)) continue;
      if (covered.has(logical)) {
        seenLogicals.add(logical);
        continue;
      }
      let joint:
        | import('./ink/packed-protocol.js').PackedCompiledInk
        | undefined;
      try {
        joint = jointPackedForChunk(record);
      } catch {
        continue;
      }
      if (joint === undefined) continue;
      // Mark this logical as seen (one entry per logical).
      seenLogicals.add(logical);
      // JOINT translation: owned by the joint packed identity, updated
      // exactly once per logical translation (§2.2). Independent
      // per-record translations never enter the joint rebase.
      let tx = 0;
      let ty = 0;
      try {
        const t = jointTranslationOfPacked(joint);
        tx = t.tx;
        ty = t.ty;
      } catch {
        // Translation probing never breaks collection.
      }
      const entry: DerivedCachePackEntry = {
        key: derivedCacheKey(input.documentId, logical, input.revision),
        packed: joint,
        tx,
        ty,
        transfer: false,
      };
      if (bytes + packedCompiledByteLength(entry.packed) > maxBytes) break;
      push(entry);
    }
  } catch {
    // Joint collection never breaks persistence.
  }
  // Cache-only entries (never prepared this session) are already world.
  for (const entry of input.cache.compiledEntries(input.revision)) {
    if (covered.has(entry.key.objectId)) continue;
    push({
      key: entry.key,
      packed: entry.packed,
      tx: 0,
      ty: 0,
      transfer: false,
    });
  }
  return out;
}

/**
 * Cooperative-yield twin of `collectPersistEntries`: gathers ONLY
 * already-packed entries in bounded batches with a macrotask yield between
 * them. Records without a retained packed copy are skipped (never
 * synchronously packed) — a yield BETWEEN records is insufficient for one
 * huge stroke, so huge unpacked strokes are skipped entirely. Teardown stays
 * off the interaction path even without a Worker packer.
 */
export async function collectPersistEntriesAsync(
  input: {
    readonly documentId: string;
    readonly revision: string;
    readonly warm: readonly SurfaceObjectRecord[];
    readonly cache: SurfaceDerivedCache;
    readonly maxBytes?: number;
    readonly maxEntries?: number;
  },
  yieldFn: () => Promise<void> = yieldToEventLoop,
  batchSize = 32,
): Promise<DerivedCachePackEntry[]> {
  const maxBytes = input.maxBytes ?? DERIVED_CACHE_MAX_COMPILED_BYTES;
  const maxEntries = input.maxEntries ?? DERIVED_CACHE_MAX_COMPILED;
  const out: DerivedCachePackEntry[] = [];
  const covered = new Set<string>();
  let bytes = 0;
  let sinceYield = 0;
  await yieldFn();
  const push = (entry: DerivedCachePackEntry): void => {
    const entryBytes = packedCompiledByteLength(entry.packed);
    if (out.length >= maxEntries) return;
    if (bytes + entryBytes > maxBytes) return;
    bytes += entryBytes;
    covered.add(entry.key.objectId);
    out.push(entry);
  };
  for (const record of input.warm) {
    if (out.length >= maxEntries || bytes >= maxBytes) break;
    try {
      const retained = packedCompiledForRecord(record);
      if (retained === undefined) continue;
      const { tx, ty } = derivedTranslationOfRecord(record);
      const entry: DerivedCachePackEntry = {
        key: derivedCacheKey(input.documentId, record.id, input.revision),
        packed: retained,
        tx,
        ty,
        transfer: false,
      };
      if (bytes + packedCompiledByteLength(entry.packed) > maxBytes) break;
      push(entry);
    } catch {
      // Skip only that record.
    }
    sinceYield += 1;
    if (sinceYield >= batchSize) {
      sinceYield = 0;
      await yieldFn();
    }
  }
  // Joint logical strokes (one stable entry per logical id; see sync twin
  // above for ownership: JOINT translation, not per-chunk). Bounded with
  // yields like singles.
  try {
    const seenLogicals = new Set<string>();
    for (const record of input.warm) {
      if (out.length >= maxEntries || bytes >= maxBytes) break;
      let logical: string | null = null;
      try {
        logical = logicalIdOf(record);
      } catch {
        continue;
      }
      if (logical === null || seenLogicals.has(logical)) {
        // Still yield for progress on large warm lists.
        sinceYield += 1;
        if (sinceYield >= batchSize) {
          sinceYield = 0;
          await yieldFn();
        }
        continue;
      }
      if (covered.has(logical)) {
        seenLogicals.add(logical);
        sinceYield += 1;
        if (sinceYield >= batchSize) {
          sinceYield = 0;
          await yieldFn();
        }
        continue;
      }
      let joint:
        | import('./ink/packed-protocol.js').PackedCompiledInk
        | undefined;
      try {
        joint = jointPackedForChunk(record);
      } catch {
        sinceYield += 1;
        if (sinceYield >= batchSize) {
          sinceYield = 0;
          await yieldFn();
        }
        continue;
      }
      if (joint === undefined) {
        sinceYield += 1;
        if (sinceYield >= batchSize) {
          sinceYield = 0;
          await yieldFn();
        }
        continue;
      }
      seenLogicals.add(logical);
      let tx = 0;
      let ty = 0;
      try {
        const t = jointTranslationOfPacked(joint);
        tx = t.tx;
        ty = t.ty;
      } catch {
        // Ignore.
      }
      const entry: DerivedCachePackEntry = {
        key: derivedCacheKey(input.documentId, logical, input.revision),
        packed: joint,
        tx,
        ty,
        transfer: false,
      };
      if (bytes + packedCompiledByteLength(entry.packed) > maxBytes) break;
      push(entry);
      sinceYield += 1;
      if (sinceYield >= batchSize) {
        sinceYield = 0;
        await yieldFn();
      }
    }
  } catch {
    // Joint collection never breaks persistence.
  }
  for (const entry of input.cache.compiledEntries(input.revision)) {
    if (covered.has(entry.key.objectId)) continue;
    push({
      key: entry.key,
      packed: entry.packed,
      tx: 0,
      ty: 0,
      transfer: false,
    });
  }
  return out;
}

/**
 * Cooperative main-thread packer (headless/tests/no-Worker hosts):
 * applies world rebase and builds the binary container in bounded,
 * yielding steps. The production hosts use the Worker-backed packer.
 */
export async function packDerivedCacheOnMain(
  request: DerivedCachePackRequest,
  yieldFn: () => Promise<void> = yieldToEventLoop,
  batchSize = 64,
): Promise<Uint8Array> {
  const compiled: { key: DerivedCacheKey; packed: PackedCompiledInk }[] = [];
  let sinceYield = 0;
  for (const entry of request.compiled) {
    compiled.push({
      key: entry.key,
      packed:
        entry.tx === 0 && entry.ty === 0
          ? entry.packed
          : rebasePackedCompiledInk(entry.packed, entry.tx, entry.ty),
    });
    sinceYield += 1;
    if (sinceYield >= batchSize) {
      sinceYield = 0;
      await yieldFn();
    }
  }
  return serializeDerivedCacheBinary({ bounds: request.bounds, compiled });
}

export interface DerivedCacheLazyPackResult {
  readonly manifest: Uint8Array;
  readonly entries: { readonly objectId: string; readonly bytes: Uint8Array }[];
}

/**
 * Pure truly-lazy packing (shared by Worker and main-thread fallback):
 * world-coordinate rebase + per-entry standalone binaries + lightweight
 * manifest/index. No B-spline compiles, no object-graph expansion — entries
 * arrive already packed (retained), rebase copies only XY fields.
 */
export function packLazyManifestContainer(
  request: DerivedCachePackRequest,
): DerivedCacheLazyPackResult {
  const entries: { objectId: string; bytes: Uint8Array }[] = [];
  const manifestEntries: {
    objectId: string;
    bounds: Bounds | null;
    bytes: number;
  }[] = [];
  const boundsById = new Map<string, Bounds | null>();
  for (const b of request.bounds) {
    boundsById.set(b.key.objectId, b.bounds);
  }
  for (const entry of request.compiled) {
    const world =
      entry.tx === 0 && entry.ty === 0
        ? entry.packed
        : rebasePackedCompiledInk(entry.packed, entry.tx, entry.ty);
    const bytes = encodeDerivedCacheEntry(entry.key, world);
    entries.push({ objectId: entry.key.objectId, bytes });
    manifestEntries.push({
      objectId: entry.key.objectId,
      bounds: boundsById.get(entry.key.objectId) ?? null,
      bytes: packedCompiledByteLength(world),
    });
  }
  const manifest: DerivedCacheManifest = {
    version: DERIVED_CACHE_VERSION,
    compilerVersion: INK_COMPILER_VERSION,
    documentId: request.documentId,
    revision: request.revision,
    entries: manifestEntries,
  };
  return { manifest: encodeDerivedCacheManifest(manifest), entries };
}

/**
 * Cooperative main-thread lazy packer (no-Worker fallback): same output as
 * the Worker lazy packer, yielding between entries so teardown never
 * monopolizes the thread. Only retained packed entries (no `packCompiledInk`).
 */
export async function packLazyManifestOnMain(
  request: DerivedCachePackRequest,
  yieldFn: () => Promise<void> = yieldToEventLoop,
  batchSize = 32,
): Promise<DerivedCacheLazyPackResult> {
  const entries: { objectId: string; bytes: Uint8Array }[] = [];
  const manifestEntries: {
    objectId: string;
    bounds: Bounds | null;
    bytes: number;
  }[] = [];
  const boundsById = new Map<string, Bounds | null>();
  for (const b of request.bounds) {
    boundsById.set(b.key.objectId, b.bounds);
  }
  let sinceYield = 0;
  await yieldFn();
  for (const entry of request.compiled) {
    const world =
      entry.tx === 0 && entry.ty === 0
        ? entry.packed
        : rebasePackedCompiledInk(entry.packed, entry.tx, entry.ty);
    const bytes = encodeDerivedCacheEntry(entry.key, world);
    entries.push({ objectId: entry.key.objectId, bytes });
    manifestEntries.push({
      objectId: entry.key.objectId,
      bounds: boundsById.get(entry.key.objectId) ?? null,
      bytes: packedCompiledByteLength(world),
    });
    sinceYield += 1;
    if (sinceYield >= batchSize) {
      sinceYield = 0;
      await yieldFn();
    }
  }
  const manifest: DerivedCacheManifest = {
    version: DERIVED_CACHE_VERSION,
    compilerVersion: INK_COMPILER_VERSION,
    documentId: request.documentId,
    revision: request.revision,
    entries: manifestEntries,
  };
  return { manifest: encodeDerivedCacheManifest(manifest), entries };
}

/**
 * Host-owned durable storage for derived caches. One shared abstraction
 * for Ink, Notebook, and Whiteboard hosts:
 *
 * - Tauri/native: application cache directory (non-user-content);
 * - Web/PWA: OPFS derived-cache storage;
 * - tests/headless: in-memory implementation.
 *
 * Payloads are compact binary containers (`SurfaceDerivedCache`), never
 * base64. Implementations may be async (OPFS, Tauri IPC); the store
 * queues work and never blocks editor teardown. `remove` is optional and
 * best-effort. This is DISPOSABLE cache data: it is never synced through
 * cloud vault sync, deletion is harmless, and any failure degrades to a
 * cache miss (canonical content recompiles).
 */
export interface DerivedCacheStoragePort {
  load(documentId: string): Uint8Array | null | Promise<Uint8Array | null>;
  save(documentId: string, bytes: Uint8Array): void | Promise<void>;
  remove?(documentId: string): void | Promise<void>;
}

/**
 * Live provider/session binding for one mounted surface (item 1). The
 * revision is read through `getContentRevision()` at every use — mount
 * restore AND teardown persistence — so a successful save (which changes
 * `DocumentSession.contentRevision`) is picked up without remounting.
 * `isDirty()` gates both directions: no cached geometry is trusted or
 * persisted while the in-memory model differs from the stored bytes.
 */
export interface SurfaceReopenBinding {
  readonly store: DerivedReopenStore;
  readonly documentId: string;
  getContentRevision(): string | null;
  isDirty(): boolean;
}

/** Live revision read that never lets a throwing accessor break an open. */
export function liveContentRevision(
  binding: SurfaceReopenBinding,
): string | null {
  try {
    const revision = binding.getContentRevision();
    return typeof revision === 'string' && revision.length > 0
      ? revision
      : null;
  } catch {
    return null;
  }
}

/** Live dirty read that fails closed (a throwing accessor is "dirty"). */
export function liveIsDirty(binding: SurfaceReopenBinding): boolean {
  try {
    return binding.isDirty();
  } catch {
    return true;
  }
}

/**
 * Restore validated cached vectors under the binding's CURRENT revision.
 * Returns null when the revision is unavailable or the model is dirty
 * (unsaved edits never consume geometry keyed to the saved revision).
 * Never throws.
 */
export function restoreLiveReopenGeometry(
  binding: SurfaceReopenBinding,
  model: Pick<SurfaceModel, 'objects' | 'order'>,
): RestoreCompiledStats | null {
  if (liveIsDirty(binding)) return null;
  const revision = liveContentRevision(binding);
  if (revision === null) return null;
  try {
    const cache = binding.store.acquire(binding.documentId, revision);
    return restoreCachedCompiledGeometry({
      documentId: binding.documentId,
      revision,
      model,
      cache,
    });
  } catch {
    return null;
  }
}

/**
 * Schedule asynchronous persistence of viewport-warm vectors under the
 * binding's CURRENT revision. Returns the revision queued, or null when
 * unavailable/dirty (unsaved geometry is NEVER associated with the last
 * saved revision). The returned revision is informational — the job is
 * dispatched immediately and never awaited here; editor teardown must
 * stay constant-time.
 */
export function persistLiveReopenGeometry(
  binding: SurfaceReopenBinding,
  model: Pick<SurfaceModel, 'objects' | 'order'>,
): string | null {
  if (liveIsDirty(binding)) return null;
  const revision = liveContentRevision(binding);
  if (revision === null) return null;
  binding.store.scheduleWarmCompiledGeometry({
    documentId: binding.documentId,
    revision,
    model,
    // Re-checked when the queued job actually starts AND immediately
    // before the host write: a queued job must never persist geometry for
    // a session that has since become dirty or moved to a new revision.
    revalidate: () =>
      !liveIsDirty(binding) && liveContentRevision(binding) === revision,
  });
  return revision;
}

interface ReopenEntry {
  cache: SurfaceDerivedCache;
  revision: string;
  /** Monotonic generation: revision changes bump it so late R0 loads are stale. */
  generation: number;
  /**
   * Resolves `true` when the durable manifest was applied AFTER the
   * synchronous acquire; `false` when nothing was pending (sync load
   * already applied, no storage, stale/corrupt manifest, or load failed).
   * Manifest-only: packed entries stay on disk until preparation needs
   * them (truly lazy).
   */
  hydration: Promise<boolean>;
  /** Durable manifest index (objectId → bounds/bytes), null until loaded. */
  manifest: Map<string, { bounds: Bounds | null; bytes: number }> | null;
  /** True once the manifest load settled (found or miss). */
  manifestLoaded: boolean;
  /** Manifest bytes (diagnostics). */
  manifestBytes: number;
  /** Manifest load wall-clock ms (diagnostics). */
  manifestLoadMs: number;
  /** In-flight per-entry durable loads (deduplicated, bounded by preparation). */
  inFlightEntryLoads: Map<string, Promise<PackedCompiledInk | null>>;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/**
 * Provider-owned reopen-cache pool (bounded, revision-keyed, optionally
 * durable, asynchronously persisted).
 *
 * One `SurfaceDerivedCache` per open document, bounded (insertion-order
 * eviction past the cap) so long-lived providers cannot leak. A revision
 * change for a document drops its whole entry set (conservative:
 * per-object revisions do not exist, so any canonical change retires all
 * of that document's cached geometry — decode seeds + Worker cover the
 * reopen). Persistence is queued: `destroy()` enqueues and returns, and
 * jobs whose revision moved on are discarded before touching storage.
 */
export class DerivedReopenStore {
  private readonly entries = new Map<string, ReopenEntry>();
  private readonly cap: number;
  private readonly storage: DerivedCacheStoragePort | null;
  private readonly createPacker: (() => DerivedCachePacker | null) | null;
  /** Lazily created off-thread packer (undefined = not attempted yet). */
  #packer: DerivedCachePacker | null | undefined;
  private evictions = 0;
  private staleHydrationsDiscarded = 0;
  private generationCounter = 0;
  // Truly-lazy durable diagnostics (closure pass).
  private manifestLoads = 0;
  private manifestLoadMsTotal = 0;
  private manifestBytesTotal = 0;
  private durablePackedReads = 0;
  private durablePackedReadBytesTotal = 0;
  private durablePackedReadMsTotal = 0;
  private staleEntrySkips = 0;
  private corruptEntrySkips = 0;
  /** Serialized persistence lane: bounded, no concurrent whole-cache writes. */
  #chain: Promise<void> = Promise.resolve();

  constructor(
    cap = 32,
    storage: DerivedCacheStoragePort | null = null,
    options: { readonly createPacker?: () => DerivedCachePacker | null } = {},
  ) {
    this.cap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 32;
    this.storage = storage;
    this.createPacker = options.createPacker ?? null;
  }

  /** Cache for `documentId` at `revision` (invalidated on change). */
  acquire(documentId: string, revision: string): SurfaceDerivedCache {
    const existing = this.entries.get(documentId);
    if (existing !== undefined) {
      if (existing.revision === revision) {
        // Most-recently-used first (stable eviction order).
        this.entries.delete(documentId);
        this.entries.set(documentId, existing);
        return existing.cache;
      }
      existing.cache.invalidateDocument(documentId);
      existing.revision = revision;
      this.generationCounter += 1;
      existing.generation = this.generationCounter;
      // A revision change retires pending R0 hydration AND the manifest
      // index: the old async load carries the previous generation and can
      // never install afterwards.
      existing.hydration = Promise.resolve(false);
      existing.manifest = null;
      existing.manifestLoaded = false;
      existing.manifestBytes = 0;
      existing.manifestLoadMs = 0;
      existing.inFlightEntryLoads.clear();
      this.staleHydrationsDiscarded += 1;
      this.entries.delete(documentId);
      this.entries.set(documentId, existing);
      // Immediately start the R1 manifest load (cheap index only).
      this.#startManifestLoad(documentId, existing, revision);
      return existing.cache;
    }
    this.generationCounter += 1;
    const created: ReopenEntry = {
      cache: new SurfaceDerivedCache(),
      revision,
      generation: this.generationCounter,
      hydration: Promise.resolve(false),
      manifest: null,
      manifestLoaded: false,
      manifestBytes: 0,
      manifestLoadMs: 0,
      inFlightEntryLoads: new Map(),
    };
    this.entries.set(documentId, created);
    // Durable restore: load ONLY the lightweight manifest/index (bounds +
    // per-entry locators). Packed entries stay on disk until preparation
    // priority needs them (truly lazy). Corrupt/stale manifests are safe
    // misses. Async hosts resolve later; `hydrate` exposes that promise.
    // Generation/entry-identity/revision ownership: a late R0 manifest
    // never becomes visible after R1 is current.
    this.#startManifestLoad(documentId, created, revision);
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#dropEntry(oldest, true);
    }
    return created.cache;
  }

  /** Start (or synchronously apply) the manifest load for an entry. */
  #startManifestLoad(
    documentId: string,
    entry: ReopenEntry,
    revision: string,
  ): void {
    if (this.storage === null) {
      entry.manifestLoaded = true;
      entry.hydration = Promise.resolve(false);
      return;
    }
    const generation = entry.generation;
    const applyManifest = (bytes: Uint8Array | null): boolean => {
      if (
        this.entries.get(documentId) !== entry ||
        entry.revision !== revision ||
        entry.generation !== generation
      ) {
        this.staleHydrationsDiscarded += 1;
        return false;
      }
      if (bytes === null) {
        entry.manifest = new Map();
        entry.manifestLoaded = true;
        return false;
      }
      const start = this.#nowMs();
      const manifest = decodeDerivedCacheManifest(bytes, documentId, revision);
      const loadMs = this.#nowMs() - start;
      this.manifestLoads += 1;
      this.manifestLoadMsTotal += loadMs;
      this.manifestBytesTotal += bytes.byteLength;
      entry.manifestLoadMs = loadMs;
      entry.manifestBytes = bytes.byteLength;
      if (manifest === null) {
        // Stale/corrupt manifest or legacy monolithic container: disposable,
        // safely ignored. Delete ONLY legacy binary containers (not JSON
        // manifests for a different revision — those are valid for their own
        // revision and must survive R0-vs-R1 probes).
        entry.manifest = new Map();
        entry.manifestLoaded = true;
        entry.manifestBytes = bytes.byteLength;
        entry.manifestLoadMs = loadMs;
        const isJsonManifest = bytes.length > 0 && bytes[0] === 0x7b; // '{'
        if (!isJsonManifest) {
          this.staleHydrationsDiscarded += 1;
          try {
            const remove = this.storage?.remove;
            if (typeof remove === 'function') {
              void Promise.resolve(remove.call(this.storage, documentId)).catch(
                () => undefined,
              );
            }
          } catch {
            // Best-effort only.
          }
        }
        return false;
      }
      const index = new Map<string, { bounds: Bounds | null; bytes: number }>();
      for (const item of manifest.entries) {
        index.set(item.objectId, { bounds: item.bounds, bytes: item.bytes });
        try {
          entry.cache.storeBounds(
            {
              documentId,
              objectId: item.objectId,
              revision,
              compilerVersion: INK_COMPILER_VERSION,
              cacheVersion: DERIVED_CACHE_VERSION,
            },
            item.bounds,
          );
        } catch {
          // Bounds seeding never breaks open.
        }
      }
      entry.manifest = index;
      entry.manifestLoaded = true;
      return index.size > 0;
    };
    try {
      const loaded = this.storage.load(documentId);
      if (isPromiseLike(loaded)) {
        entry.hydration = Promise.resolve(loaded)
          .then((bytes) => {
            try {
              return applyManifest(bytes);
            } catch {
              return false;
            }
          })
          .catch(() => false);
      } else {
        const installed = applyManifest(loaded);
        entry.hydration = Promise.resolve(installed);
      }
    } catch {
      entry.manifest = new Map();
      entry.manifestLoaded = true;
      entry.hydration = Promise.resolve(false);
    }
  }

  #nowMs(): number {
    try {
      const perf = (
        globalThis as unknown as { performance?: { now(): number } }
      ).performance;
      if (perf !== undefined && typeof perf.now === 'function') {
        return perf.now();
      }
    } catch {
      // Fall through.
    }
    return Date.now();
  }

  /**
   * True when the memory cache holds a packed slot for the object (peek,
   * no validation, no counters). Used to distinguish immediate packed hits
   * (render now, no async) from durable-disk pending (defer + preload).
   */
  hasMemoryPacked(
    documentId: string,
    revision: string,
    objectId: string,
  ): boolean {
    const entry = this.entries.get(documentId);
    if (entry === undefined || entry.revision !== revision) return false;
    try {
      return entry.cache.hasCompiledSlot(
        derivedCacheKey(documentId, objectId, revision),
      );
    } catch {
      return false;
    }
  }

  /**
   * True when a durable packed entry exists on disk for the object
   * (manifest index hit OR manifest still pending). Used by preparation to
   * defer synchronous B-spline compiles while the async entry load is
   * pending: cached reopen never compiles what the durable cache holds.
   * Excludes memory hits (those render immediately via `restorePacked`).
   */
  hasDurableEntry(
    documentId: string,
    revision: string,
    objectId: string,
  ): boolean {
    const entry = this.entries.get(documentId);
    if (entry === undefined || entry.revision !== revision) return false;
    const manifest = entry.manifest;
    if (manifest !== undefined && manifest !== null && manifest.has(objectId)) {
      return true;
    }
    // Manifest not yet loaded: conservatively assume durable MAY exist so
    // first paint defers sync compiles until the cheap index resolves
    // (few ms) rather than burning B-spline compiles that the cache holds.
    if (!entry.manifestLoaded && this.storage !== null) return true;
    return false;
  }

  /**
   * Load ONE durable packed entry on demand (viewport/prefetch priority
   * only). Memory hit returns synchronously; durable hits read exactly one
   * per-entry record, validate it, install it into the memory cache, and
   * return it. Stale/corrupt entries are safe misses (counted). Deduplicates
   * concurrent loads for the same object so panning never fans out
   * unbounded storage requests. Never throws.
   */
  async loadDurableEntry(
    documentId: string,
    revision: string,
    objectId: string,
  ): Promise<PackedCompiledInk | null> {
    const entry = this.entries.get(documentId);
    if (entry === undefined || entry.revision !== revision) {
      this.staleEntrySkips += 1;
      return null;
    }
    try {
      const key = derivedCacheKey(documentId, objectId, revision);
      const hit = entry.cache.loadCompiled(key);
      if (hit !== undefined) return hit;
    } catch {
      // Fall through to durable.
    }
    const manifest = entry.manifest;
    if (
      manifest === undefined ||
      manifest === null ||
      !manifest.has(objectId)
    ) {
      // No manifest entry: if the index hasn't loaded yet, wait for it once
      // (cheap) then re-check — avoids compiling what the manifest holds.
      if (!entry.manifestLoaded) {
        try {
          await entry.hydration;
        } catch {
          // Ignore; fall through to miss.
        }
        const reloaded = this.entries.get(documentId);
        if (reloaded === undefined || reloaded.revision !== revision) {
          this.staleEntrySkips += 1;
          return null;
        }
        try {
          const key = derivedCacheKey(documentId, objectId, revision);
          const hit = reloaded.cache.loadCompiled(key);
          if (hit !== undefined) return hit;
        } catch {
          // Fall through.
        }
        const reloadedManifest = reloaded.manifest;
        if (
          reloadedManifest === undefined ||
          reloadedManifest === null ||
          !reloadedManifest.has(objectId)
        ) {
          return null;
        }
        // Fall through to the durable read below with the reloaded entry.
        return this.loadDurableEntry(documentId, revision, objectId);
      }
      return null;
    }
    const inFlight = entry.inFlightEntryLoads.get(objectId);
    if (inFlight !== undefined) {
      try {
        return await inFlight;
      } catch {
        return null;
      }
    }
    const task = (async (): Promise<PackedCompiledInk | null> => {
      if (this.storage === null) return null;
      const storageKey = derivedCacheEntryStorageKey(documentId, objectId);
      const start = this.#nowMs();
      let bytes: Uint8Array | null;
      try {
        bytes = await this.storage.load(storageKey);
      } catch {
        return null;
      }
      const readMs = this.#nowMs() - start;
      if (
        this.entries.get(documentId) !== entry ||
        entry.revision !== revision
      ) {
        this.staleEntrySkips += 1;
        return null;
      }
      if (bytes === null) {
        // Missing entry file (orphaned manifest reference or never
        // persisted): drop the index entry so preparation stops deferring
        // and compiles normally instead of looping forever.
        this.staleEntrySkips += 1;
        try {
          entry.manifest?.delete(objectId);
        } catch {
          // Ignore.
        }
        return null;
      }
      this.durablePackedReads += 1;
      this.durablePackedReadBytesTotal += bytes.byteLength;
      this.durablePackedReadMsTotal += readMs;
      const decoded = decodeDerivedCacheEntry(
        bytes,
        documentId,
        objectId,
        revision,
      );
      if (decoded === null) {
        // Corrupt payload: drop the index entry so the next slice compiles
        // normally (safe miss) instead of deferring forever.
        this.corruptEntrySkips += 1;
        try {
          entry.manifest?.delete(objectId);
        } catch {
          // Ignore.
        }
        return null;
      }
      try {
        entry.cache.storeCompiled(decoded.key, decoded.packed);
      } catch {
        this.corruptEntrySkips += 1;
        try {
          entry.manifest?.delete(objectId);
        } catch {
          // Ignore.
        }
        return null;
      }
      try {
        return entry.cache.loadCompiled(decoded.key) ?? null;
      } catch {
        return null;
      }
    })();
    entry.inFlightEntryLoads.set(objectId, task);
    try {
      return await task;
    } finally {
      if (entry.inFlightEntryLoads.get(objectId) === task) {
        entry.inFlightEntryLoads.delete(objectId);
      }
    }
  }

  /**
   * Resolves `true` when a document's durable manifest installed its index
   * after `acquire` returned (mounts re-run preparation then). Manifest-only:
   * packed entries stay on disk until preparation needs them. Never rejects.
   */
  hydrate(documentId: string): Promise<boolean> {
    const entry = this.entries.get(documentId);
    return entry === undefined ? Promise.resolve(false) : entry.hydration;
  }

  /**
   * Queue durable persistence of one document's current cache (seed
   * backfill / explicit flush). Persists the lightweight manifest/index plus
   * per-entry packed records for truly-lazy reads. Returns immediately.
   */
  persist(documentId: string): void {
    const entry = this.entries.get(documentId);
    if (entry === undefined) return;
    const revision = entry.revision;
    const generation = entry.generation;
    this.#enqueue(async () => {
      const current = this.entries.get(documentId);
      if (
        current !== entry ||
        current.revision !== revision ||
        current.generation !== generation
      ) {
        return;
      }
      if (this.storage === null) return;
      try {
        const manifest = this.#buildManifest(documentId, revision, current);
        // Save per-entry packed records first (from the memory cache, which
        // holds world-positioned packed payloads), manifest last.
        for (const compiled of current.cache.compiledEntries(revision)) {
          if (
            this.entries.get(documentId) !== current ||
            current.revision !== revision ||
            current.generation !== generation
          ) {
            return;
          }
          try {
            const bytes = encodeDerivedCacheEntry(
              compiled.key,
              compiled.packed,
            );
            await this.storage.save(
              derivedCacheEntryStorageKey(documentId, compiled.key.objectId),
              bytes,
            );
          } catch {
            // Single-entry failures are safe misses (manifest still references
            // them; missing files are stale skips on read).
          }
        }
        if (
          this.entries.get(documentId) !== current ||
          current.revision !== revision ||
          current.generation !== generation
        ) {
          return;
        }
        const bytes = encodeDerivedCacheManifest(manifest);
        this.manifestBytesTotal += bytes.byteLength;
        await this.storage.save(documentId, bytes);
        current.manifest = new Map(
          manifest.entries.map((e) => [
            e.objectId,
            { bounds: e.bounds, bytes: e.bytes },
          ]),
        );
        current.manifestLoaded = true;
        current.manifestBytes = bytes.byteLength;
      } catch {
        // Persistence never breaks editing.
      }
    });
  }

  /** Build the lightweight manifest/index for a revision (no geometry copies). */
  #buildManifest(
    documentId: string,
    revision: string,
    entry: ReopenEntry,
  ): DerivedCacheManifest {
    const boundsEntries = entry.cache.boundsEntries(revision);
    const boundsById = new Map<string, Bounds | null>();
    for (const b of boundsEntries) boundsById.set(b.key.objectId, b.bounds);
    const compiled = entry.cache.compiledEntries(revision);
    return {
      version: DERIVED_CACHE_VERSION,
      compilerVersion: INK_COMPILER_VERSION,
      documentId,
      revision,
      entries: compiled.map((c) => ({
        objectId: c.key.objectId,
        bounds: boundsById.get(c.key.objectId) ?? null,
        bytes: packedCompiledByteLength(c.packed),
      })),
    };
  }

  /**
   * Queue teardown persistence of warm compiled geometry (closure pass):
   * gathers ONLY already-packed entries (never `packCompiledInk` on the UI
   * thread — unpacked live records are skipped for a later teardown after
   * background packing retains them), rebases + per-entry encodes +
   * manifest off-thread when a packer exists (else cooperatively with
   * yields), then writes manifest + per-entry records for truly-lazy reads.
   * Called from `destroy()`; must never block or throw.
   *
   * Staleness invariant: the queued job revalidates the session
   * (`revalidate`), the store entry identity/generation, and the captured
   * revision when it STARTS and again immediately before each host write.
   * Dirty sessions, moved revisions, or replaced entries discard the job
   * without writing stale cache data.
   */
  scheduleWarmCompiledGeometry(input: {
    readonly documentId: string;
    readonly revision: string;
    readonly model: Pick<SurfaceModel, 'objects' | 'order'>;
    /** Live session revalidation (clean + same revision). */
    readonly revalidate?: () => boolean;
    /** Pre-collected warm records (defaults to scanning `model.order`). */
    readonly warm?: readonly SurfaceObjectRecord[];
  }): void {
    const { documentId, revision } = input;
    // Capture the warm-record snapshot and revalidation closure NOW so the
    // queued job never retains the mutable session/model; record identity +
    // revalidation guard correctness (clean + same revision means no
    // content moved).
    const warm = input.warm ?? collectWarmRecords(input.model);
    const revalidateInput = input.revalidate;
    let entry = this.entries.get(documentId);
    if (entry !== undefined && entry.revision !== revision) {
      entry.cache.invalidateDocument(documentId);
      entry.revision = revision;
      this.generationCounter += 1;
      entry.generation = this.generationCounter;
      entry.hydration = Promise.resolve(false);
      entry.manifest = null;
      entry.manifestLoaded = false;
      entry.manifestBytes = 0;
      entry.manifestLoadMs = 0;
      entry.inFlightEntryLoads.clear();
      this.staleHydrationsDiscarded += 1;
    } else if (entry === undefined) {
      this.generationCounter += 1;
      entry = {
        cache: new SurfaceDerivedCache(),
        revision,
        generation: this.generationCounter,
        hydration: Promise.resolve(false),
        manifest: null,
        manifestLoaded: false,
        manifestBytes: 0,
        manifestLoadMs: 0,
        inFlightEntryLoads: new Map(),
      };
      this.entries.set(documentId, entry);
      while (this.entries.size > this.cap) {
        const oldest = this.entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#dropEntry(oldest, true);
      }
    }
    const target = entry;
    const revalidate = (): boolean => {
      if (this.entries.get(documentId) !== target) return false;
      if (target.revision !== revision) return false;
      try {
        return revalidateInput === undefined || revalidateInput();
      } catch {
        return false;
      }
    };
    this.#enqueue(async () => {
      if (!revalidate()) return;
      const packer = this.#ensurePacker();
      if (this.storage === null && packer === null) {
        // Memory-only store with no packer: retain already-packed entries
        // for in-session reopen (never persisted, never packed — unpacked
        // live records are skipped, background packing retains them later).
        await persistWarmCompiledRecordsAsync({
          documentId,
          revision,
          records: warm,
          cache: target.cache,
        });
        return;
      }
      if (this.storage === null) return;
      // Truly-lazy teardown persistence (closure pass): gather ONLY
      // already-packed entries (zero `packCompiledInk` on the UI thread;
      // unpacked live records are skipped), then rebase + per-entry encode
      // + manifest off-thread when a packer exists, else cooperatively on
      // the async lane with yields between entries. Manifest + entries save
      // as separate byte-store records for viewport-level lazy reads.
      // Durable budget exceeds active RAM (only viewport entries become RAM).
      try {
        const compiled = await collectPersistEntriesAsync({
          documentId,
          revision,
          warm,
          cache: target.cache,
          maxBytes: DERIVED_CACHE_DURABLE_MAX_BYTES,
          maxEntries: Math.max(target.cache.maxCompiledEntriesLimit(), 2048),
        });
        const bounds = target.cache.boundsEntries(revision);
        if (compiled.length === 0) {
          // No persistable packed geometry: still persist the lightweight
          // manifest (bounds/index) so the next open seeds cheaply, unless
          // there is nothing at all.
          if (bounds.length === 0) return;
          const emptyManifest: DerivedCacheManifest = {
            version: DERIVED_CACHE_VERSION,
            compilerVersion: INK_COMPILER_VERSION,
            documentId,
            revision,
            entries: [],
          };
          const emptyBytes = encodeDerivedCacheManifest(emptyManifest);
          if (!revalidate()) return;
          await this.storage.save(documentId, emptyBytes);
          target.manifest = new Map();
          target.manifestLoaded = true;
          target.manifestBytes = emptyBytes.byteLength;
          this.#forgetEntry(documentId, target);
          return;
        }
        const request = { documentId, revision, bounds, compiled };
        let lazy: {
          manifest: Uint8Array;
          entries: { objectId: string; bytes: Uint8Array }[];
        };
        if (packer !== null && typeof packer.packLazy === 'function') {
          try {
            lazy = await packer.packLazy(request);
          } catch {
            lazy = await packLazyManifestOnMain(request);
          }
        } else {
          lazy = await packLazyManifestOnMain(request);
        }
        if (!revalidate()) return;
        // Save entries first, manifest last (crash leaves manifest pointing
        // only to complete entries; missing entries are safe misses).
        for (const entry of lazy.entries) {
          if (!revalidate()) return;
          try {
            await this.storage.save(
              derivedCacheEntryStorageKey(documentId, entry.objectId),
              entry.bytes,
            );
          } catch {
            // Single-entry failures never break teardown; the manifest will
            // simply omit them (rebuilt below from successful saves? For
            // simplicity, manifest still references them — missing entries
            // are safe misses on read).
          }
        }
        if (!revalidate()) return;
        await this.storage.save(documentId, lazy.manifest);
        try {
          const index = decodeDerivedCacheManifest(
            lazy.manifest,
            documentId,
            revision,
          );
          if (index !== null) {
            target.manifest = new Map(
              index.entries.map((e) => [
                e.objectId,
                { bounds: e.bounds, bytes: e.bytes },
              ]),
            );
            target.manifestLoaded = true;
            target.manifestBytes = lazy.manifest.byteLength;
          }
        } catch {
          // Index bookkeeping never breaks persistence.
        }
        // Durable copies are now the source for the next acquire.
        this.#forgetEntry(documentId, target);
      } catch {
        // Persistence never breaks teardown.
      }
    });
  }

  /**
   * Await all queued persistence work (tests, explicit durability).
   * Never rejects (individual job failures are swallowed: cache writes
   * must never break editing or closing).
   */
  flushPending(): Promise<void> {
    return this.#chain;
  }

  /** Drop one document (on delete/evict), including durable storage. */
  evict(documentId: string): void {
    this.#dropEntry(documentId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  statsSnapshot(): {
    documents: number;
    evictions: number;
    staleHydrationsDiscarded: number;
    manifestLoads: number;
    manifestLoadMsTotal: number;
    manifestBytesTotal: number;
    durablePackedReads: number;
    durablePackedReadBytes: number;
    durablePackedReadMsTotal: number;
    staleEntrySkips: number;
    corruptEntrySkips: number;
    mainThreadPersistencePacks: number;
  } {
    return {
      documents: this.entries.size,
      evictions: this.evictions,
      staleHydrationsDiscarded: this.staleHydrationsDiscarded,
      manifestLoads: this.manifestLoads,
      manifestLoadMsTotal: this.manifestLoadMsTotal,
      manifestBytesTotal: this.manifestBytesTotal,
      durablePackedReads: this.durablePackedReads,
      durablePackedReadBytes: this.durablePackedReadBytesTotal,
      durablePackedReadMsTotal: this.durablePackedReadMsTotal,
      staleEntrySkips: this.staleEntrySkips,
      corruptEntrySkips: this.corruptEntrySkips,
      mainThreadPersistencePacks:
        persistenceTripwires.mainThreadPersistencePacks,
    };
  }

  #dropEntry(documentId: string, countEviction = false): void {
    const removed = this.entries.get(documentId);
    const manifestEntries =
      removed?.manifest !== undefined && removed?.manifest !== null
        ? [...removed.manifest.keys()]
        : [];
    if (this.entries.delete(documentId) && countEviction) this.evictions += 1;
    if (this.storage?.remove === undefined) return;
    const remove = this.storage.remove.bind(this.storage);
    this.#enqueue(async () => {
      try {
        await remove(documentId);
      } catch {
        // Removal is best-effort: a stale durable file is a safe miss.
      }
      for (const objectId of manifestEntries) {
        try {
          await remove(derivedCacheEntryStorageKey(documentId, objectId));
        } catch {
          // Best-effort per-entry cleanup.
        }
      }
    });
  }

  /**
   * Drop the in-memory entry but KEEP durable storage: the durable
   * container is now the authoritative cache for this document, and the
   * next `acquire` rehydrates it asynchronously (same path as a fresh
   * provider restart). Only forget the entry the job actually persisted.
   */
  #forgetEntry(documentId: string, expected: ReopenEntry): void {
    if (this.entries.get(documentId) === expected) {
      this.entries.delete(documentId);
    }
  }

  /** Lazily construct the off-thread packer (null = unavailable). */
  #ensurePacker(): DerivedCachePacker | null {
    if (this.#packer !== undefined) return this.#packer;
    if (this.createPacker === null) {
      this.#packer = null;
      return null;
    }
    try {
      this.#packer = this.createPacker();
    } catch {
      this.#packer = null;
    }
    return this.#packer;
  }

  #enqueue(job: () => Promise<void> | void): void {
    const next = this.#chain.then(job).then(
      () => undefined,
      () => undefined,
    );
    this.#chain = next;
  }
}
