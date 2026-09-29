/**
 * Disposable derived-open cache with a binary durable container.
 *
 * Non-authoritative, fully rebuildable cold-start data keyed by
 * (document identity, canonical content revision, object identity, Ink
 * compiler version, cache schema version). The canonical Surface file
 * remains the source of truth; deleting this cache never destroys user
 * content (bounds reseed from decode, geometry recompiles from samples).
 *
 * Two versioned slots share one keying contract:
 * - bounds: cheap envelopes for index seeding;
 * - packed compiled geometry (`PackedCompiledInk`, the SAME packed
 *   representation the Worker produces): reopen restores valid derived
 *   vectors with zero B-spline compiles, and the Worker compiles only
 *   cache misses.
 *
 * Storage-agnostic in-memory maps with explicit ownership (no global
 * singleton — owners create/dispose per document). Hosts persist via
 * `serializeBinary()` — a compact little-endian binary container that
 * stores typed arrays verbatim (no base64, no JSON stringification of
 * geometry) — into any byte-store (`DerivedCacheStoragePort`); restore
 * revalidates everything and skips stale/corrupt entries. Never
 * persisted: live predictions, transient selection state.
 *
 * Seams:
 * - `INK_COMPILER_VERSION` (objects.ts) bumps invalidate cached geometry.
 * - `DerivedCacheKey` binds entries to (documentId, objectId, revision).
 */

import { INK_COMPILER_VERSION } from './objects.js';
import type { Bounds } from './geometry.js';
import { isBoundsLike } from './open-metadata.js';
import {
  PACKED_INK_TRANSPORT_VERSION,
  packedCompiledByteLength,
  validatePackedCompiledInk,
  type PackedCompiledInk,
} from './ink/packed-protocol.js';

/** Cache format version (bump on keying/serialization changes). */
export const DERIVED_CACHE_VERSION = 1;

/**
 * Secondary object-count ceiling (oldest evicted first). Kept as a guard
 * against pathological tiny-entry workloads; the byte budget is the
 * primary bound (`DERIVED_CACHE_MAX_COMPILED_BYTES`).
 */
export const DERIVED_CACHE_MAX_COMPILED = 256;

/**
 * Default packed-geometry byte budget (24 MiB).
 *
 * Chosen conservatively for mobile memory headroom: the durable cache is
 * disposable derived data while the canonical document, editor scene,
 * and decoded assets share the same address space. 24 MiB holds a few
 * hundred warm strokes at realistic handwriting sample counts and keeps
 * the persisted container well below the allocation spikes OPFS/Tauri
 * writes can tolerate on iPad/Android. Hosts may override through
 * `SurfaceDerivedCache` options.
 */
export const DERIVED_CACHE_MAX_COMPILED_BYTES = 24 * 1024 * 1024;

/**
 * Durable (on-disk) packed-geometry byte budget (128 MiB).
 *
 * Only viewport/prefetch entries ever become active RAM geometry (bounded
 * by `DERIVED_CACHE_MAX_COMPILED_BYTES`), so the durable cache may safely
 * exceed active RAM: a dense 5×8000 document (~65 MiB packed) persists all
 * five huge strokes for lazy per-entry reads, while each open materializes
 * only its visible slice. Disposable; hosts may override via store options
 * in the future (currently fixed to keep the port stable).
 */
export const DERIVED_CACHE_DURABLE_MAX_BYTES = 128 * 1024 * 1024;

/** Binary container magic (`FLDC`, little-endian u32). */
const DERIVED_CACHE_MAGIC = 0x43444c46;

export interface DerivedCacheKey {
  /** Stable document identity (vault path, notebook page id, etc.). */
  readonly documentId: string;
  /** Object id within the document. */
  readonly objectId: string;
  /** Canonical revision of the object (hash, mtime, or edit counter). */
  readonly revision: string;
  /** Ink compiler version that produced the entry. */
  readonly compilerVersion: number;
  /** Cache format version. */
  readonly cacheVersion: number;
}

export function derivedCacheKey(
  documentId: string,
  objectId: string,
  revision: string,
): DerivedCacheKey {
  return {
    documentId,
    objectId,
    revision,
    compilerVersion: INK_COMPILER_VERSION,
    cacheVersion: DERIVED_CACHE_VERSION,
  };
}

/** True when the entry was produced by the current compiler + format. */
export function isDerivedCacheKeyCurrent(key: DerivedCacheKey): boolean {
  return (
    key.compilerVersion === INK_COMPILER_VERSION &&
    key.cacheVersion === DERIVED_CACHE_VERSION
  );
}

/**
 * Durable per-entry storage key convention (truly-lazy closure pass).
 *
 * The manifest lives at `documentId` (small JSON index). Each packed entry
 * lives at its own record so viewport preparation fetches ONLY the entries
 * it needs — never the whole 24 MiB container. Reuses the existing
 * `DerivedCacheStoragePort` (OPFS files, Tauri cache files, memory map)
 * without new host commands: any document-id string already maps to a
 * stable file.
 */
export function derivedCacheEntryStorageKey(
  documentId: string,
  objectId: string,
): string {
  return `${documentId}::froglight-entry::${objectId}`;
}

export interface DerivedCacheManifestEntry {
  readonly objectId: string;
  readonly bounds: Bounds | null;
  readonly bytes: number;
}

export interface DerivedCacheManifest {
  readonly version: number;
  readonly compilerVersion: number;
  readonly documentId: string;
  readonly revision: string;
  readonly entries: readonly DerivedCacheManifestEntry[];
}

/** Encode a manifest index as UTF-8 JSON bytes (cheap, no geometry). */
export function encodeDerivedCacheManifest(
  manifest: DerivedCacheManifest,
): Uint8Array {
  const json = JSON.stringify({
    version: manifest.version,
    compilerVersion: manifest.compilerVersion,
    documentId: manifest.documentId,
    revision: manifest.revision,
    entries: manifest.entries.map((e) => ({
      objectId: e.objectId,
      bounds: e.bounds,
      bytes: e.bytes,
    })),
  });
  try {
    const Encoder = (
      globalThis as unknown as {
        TextEncoder?: new () => { encode(s: string): Uint8Array };
      }
    ).TextEncoder;
    if (typeof Encoder === 'function') {
      return new Encoder().encode(json);
    }
  } catch {
    // Fall through to manual ASCII (manifest is JSON ASCII-safe).
  }
  const out = new Uint8Array(json.length);
  for (let i = 0; i < json.length; i++) out[i] = json.charCodeAt(i) & 0xff;
  return out;
}

/** Decode + validate a manifest; null means stale/corrupt → safe miss. */
export function decodeDerivedCacheManifest(
  bytes: Uint8Array,
  expectedDocumentId: string,
  expectedRevision: string,
): DerivedCacheManifest | null {
  try {
    let json: string;
    try {
      const Decoder = (
        globalThis as unknown as {
          TextDecoder?: new () => { decode(b: Uint8Array): string };
        }
      ).TextDecoder;
      if (typeof Decoder === 'function') {
        json = new Decoder().decode(bytes);
      } else {
        throw new Error('no TextDecoder');
      }
    } catch {
      let s = '';
      for (let i = 0; i < bytes.length; i++)
        s += String.fromCharCode(bytes[i]!);
      json = s;
    }
    if (json.length === 0 || json[0] !== '{') return null;
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed['version'] !== DERIVED_CACHE_VERSION) return null;
    if (parsed['compilerVersion'] !== INK_COMPILER_VERSION) return null;
    if (parsed['documentId'] !== expectedDocumentId) return null;
    if (parsed['revision'] !== expectedRevision) return null;
    const rawEntries = parsed['entries'];
    if (!Array.isArray(rawEntries)) return null;
    const entries: DerivedCacheManifestEntry[] = [];
    for (const raw of rawEntries) {
      if (typeof raw !== 'object' || raw === null) return null;
      const rec = raw as Record<string, unknown>;
      if (typeof rec['objectId'] !== 'string' || rec['objectId'].length === 0) {
        return null;
      }
      const boundsRaw = rec['bounds'];
      let bounds: Bounds | null = null;
      if (boundsRaw !== null && boundsRaw !== undefined) {
        if (typeof boundsRaw !== 'object') return null;
        const b = boundsRaw as Record<string, unknown>;
        if (
          typeof b['x'] !== 'number' ||
          typeof b['y'] !== 'number' ||
          typeof b['width'] !== 'number' ||
          typeof b['height'] !== 'number'
        ) {
          return null;
        }
        bounds = {
          x: b['x'] as number,
          y: b['y'] as number,
          width: b['width'] as number,
          height: b['height'] as number,
        };
        if (!isBoundsLike(bounds)) return null;
      }
      const byteCount = rec['bytes'];
      if (typeof byteCount !== 'number' || !(byteCount >= 0)) return null;
      entries.push({
        objectId: rec['objectId'] as string,
        bounds,
        bytes: Math.floor(byteCount as number),
      });
    }
    return {
      version: DERIVED_CACHE_VERSION,
      compilerVersion: INK_COMPILER_VERSION,
      documentId: expectedDocumentId,
      revision: expectedRevision,
      entries,
    };
  } catch {
    return null;
  }
}

export interface CachedDerivedBounds {
  readonly key: DerivedCacheKey;
  readonly bounds: Bounds | null;
}

/**
 * A persisted packed-geometry entry. Entries restored from a durable
 * container are structurally parsed without per-element validation;
 * `SurfaceDerivedCache.loadCompiled()` validates lazily on first use and
 * drops corrupt payloads as safe misses.
 */
export interface CachedCompiledGeometry {
  readonly key: DerivedCacheKey;
  /**
   * Packed compiled geometry, cache-owned: callers may read/unpack but
   * must never transfer (detach) these buffers.
   */
  readonly packed: PackedCompiledInk;
}

/** One persistence pass' compiled entry (packed LOCAL + rebase). */
export interface DerivedCacheSerializedEntry {
  readonly key: DerivedCacheKey;
  readonly packed: PackedCompiledInk;
  /** Accumulated derived translation applied at serialization time. */
  readonly tx: number;
  readonly ty: number;
}

export interface SurfaceDerivedCacheStats {
  hits: number;
  misses: number;
  stores: number;
  invalidations: number;
  /** Packed-geometry loads served from valid entries. */
  compiledHits: number;
  /** Packed-geometry loads missed/invalid (Worker must compile). */
  compiledMisses: number;
  /** Packed-geometry entries stored. */
  compiledStores: number;
  /** Entries evicted by the compiled-slot bound (count or bytes). */
  compiledEvictions: number;
  /** Evictions caused by the byte budget. */
  byteEvictions: number;
  /** Current packed-geometry bytes held. */
  compiledBytes: number;
  /** Configured packed-geometry byte budget. */
  maxCompiledBytes: number;
  /** Current compiled-entry count. */
  entryCount: number;
}

export interface SurfaceDerivedCacheOptions {
  /** Secondary object-count ceiling (default `DERIVED_CACHE_MAX_COMPILED`). */
  readonly maxCompiledEntries?: number;
  /** Primary byte budget (default `DERIVED_CACHE_MAX_COMPILED_BYTES`). */
  readonly maxCompiledBytes?: number;
}

interface CompiledSlot {
  readonly key: DerivedCacheKey;
  readonly packed: PackedCompiledInk;
  readonly bytes: number;
}

/**
 * Persistent derived cache: bounds + packed compiled geometry.
 * Synchronous in-memory maps with explicit ownership (no global singleton
 * — owners create/dispose per document).
 */
export class SurfaceDerivedCache {
  private readonly bounds = new Map<string, CachedDerivedBounds>();
  private readonly compiled = new Map<string, CompiledSlot>();
  private readonly maxCompiledEntries: number;
  private readonly maxCompiledBytes: number;
  private compiledBytes = 0;
  private readonly stats: SurfaceDerivedCacheStats;

  constructor(options: SurfaceDerivedCacheOptions = {}) {
    this.maxCompiledEntries =
      Number.isFinite(options.maxCompiledEntries) &&
      (options.maxCompiledEntries ?? 0) > 0
        ? Math.floor(options.maxCompiledEntries!)
        : DERIVED_CACHE_MAX_COMPILED;
    this.maxCompiledBytes =
      Number.isFinite(options.maxCompiledBytes) &&
      (options.maxCompiledBytes ?? 0) > 0
        ? Math.floor(options.maxCompiledBytes!)
        : DERIVED_CACHE_MAX_COMPILED_BYTES;
    this.stats = {
      hits: 0,
      misses: 0,
      stores: 0,
      invalidations: 0,
      compiledHits: 0,
      compiledMisses: 0,
      compiledStores: 0,
      compiledEvictions: 0,
      byteEvictions: 0,
      compiledBytes: 0,
      maxCompiledBytes: this.maxCompiledBytes,
      entryCount: 0,
    };
  }

  private static mapKey(key: DerivedCacheKey): string {
    return `${key.documentId}\n${key.objectId}\n${key.revision}\n${key.compilerVersion}\n${key.cacheVersion}`;
  }

  private refreshStats(): void {
    this.stats.compiledBytes = this.compiledBytes;
    this.stats.entryCount = this.compiled.size;
  }

  /** Peek without validation/counters: true when a slot exists for the key. */
  hasCompiledSlot(key: DerivedCacheKey): boolean {
    if (!isDerivedCacheKeyCurrent(key)) return false;
    return this.compiled.has(SurfaceDerivedCache.mapKey(key));
  }

  statsSnapshot(): SurfaceDerivedCacheStats {
    this.refreshStats();
    return { ...this.stats };
  }

  /** Packed compiled entries currently held (cheap size read). */
  compiledEntryCount(): number {
    return this.compiled.size;
  }

  /** Packed compiled bytes currently held (tracked, no scan). */
  compiledBytesHeld(): number {
    return this.compiledBytes;
  }

  /** Configured packed-geometry byte budget. */
  maxCompiledBytesLimit(): number {
    return this.maxCompiledBytes;
  }

  /** Configured secondary compiled-entry ceiling. */
  maxCompiledEntriesLimit(): number {
    return this.maxCompiledEntries;
  }

  /**
   * Debug/test-visible invariant check: `compiledBytes` must equal the sum
   * of `packedCompiledByteLength` over every retained compiled slot.
   * Returns null when the invariant holds, otherwise a description.
   */
  debugValidateByteAccounting(): string | null {
    let sum = 0;
    for (const slot of this.compiled.values()) {
      sum += packedCompiledByteLength(slot.packed);
      if (slot.bytes !== packedCompiledByteLength(slot.packed)) {
        return `slot byte mismatch for ${slot.key.objectId}`;
      }
    }
    if (sum !== this.compiledBytes) {
      return `compiledBytes ${this.compiledBytes} != sum ${sum}`;
    }
    return null;
  }

  /** Load cached bounds when the key (revision + versions) still matches. */
  loadBounds(key: DerivedCacheKey): Bounds | null | undefined {
    if (!isDerivedCacheKeyCurrent(key)) {
      this.stats.misses += 1;
      return undefined;
    }
    const hit = this.bounds.get(SurfaceDerivedCache.mapKey(key));
    if (hit === undefined) {
      this.stats.misses += 1;
      return undefined;
    }
    this.stats.hits += 1;
    return hit.bounds === null ? null : { ...hit.bounds };
  }

  /** Store bounds for a key (overwrites stale revisions). */
  storeBounds(key: DerivedCacheKey, bounds: Bounds | null): void {
    if (!isDerivedCacheKeyCurrent(key)) return;
    if (bounds !== null && !isBoundsLike(bounds)) return;
    this.bounds.set(SurfaceDerivedCache.mapKey(key), {
      key,
      bounds: bounds === null ? null : { ...bounds },
    });
    this.stats.stores += 1;
  }

  /**
   * Load packed compiled geometry when the key (revision + versions)
   * still matches AND the payload validates. Container-restored entries
   * are validated HERE (lazily), so a durable hydrate never walks every
   * element up front. Malformed entries miss (caller recompiles via
   * Worker) — never throw, never poison state.
   */
  loadCompiled(key: DerivedCacheKey): PackedCompiledInk | undefined {
    if (!isDerivedCacheKeyCurrent(key)) {
      this.stats.compiledMisses += 1;
      return undefined;
    }
    const mapKey = SurfaceDerivedCache.mapKey(key);
    const hit = this.compiled.get(mapKey);
    if (hit === undefined) {
      this.stats.compiledMisses += 1;
      return undefined;
    }
    if (validatePackedCompiledInk(hit.packed) !== null) {
      // Corrupt entry: drop it so it can never serve again.
      this.dropSlot(mapKey);
      this.stats.compiledMisses += 1;
      this.stats.invalidations += 1;
      return undefined;
    }
    this.stats.compiledHits += 1;
    return hit.packed;
  }

  /**
   * Claim packed compiled geometry for an object entering preparation
   * (lazy reopen restore): validates, then removes the entry so it is
   * never restored twice. The caller retains the returned packed value
   * alongside the unpacked compiled geometry for persistence reuse.
   *
   * Byte accounting flows through the same `dropSlot` path as normal
   * removal/eviction so `compiledBytes` stays exactly the sum of retained
   * slots (see `debugValidateByteAccounting`).
   */
  takeCompiled(key: DerivedCacheKey): PackedCompiledInk | undefined {
    const packed = this.loadCompiled(key);
    if (packed === undefined) return undefined;
    this.dropSlot(SurfaceDerivedCache.mapKey(key));
    this.refreshStats();
    return packed;
  }

  /**
   * Store packed compiled geometry for a key (same packed representation
   * the Worker produces). Rejects stale keys and invalid payloads.
   * Bounded by BOTH the byte budget (primary) and the object-count
   * ceiling (secondary); oldest entries evict first, deterministically.
   */
  storeCompiled(key: DerivedCacheKey, packed: PackedCompiledInk): void {
    if (!isDerivedCacheKeyCurrent(key)) return;
    if (validatePackedCompiledInk(packed) !== null) return;
    this.storeSlot(key, packed);
    this.stats.compiledStores += 1;
  }

  /**
   * Store a container-restored payload. Container structure was gated at
   * parse time; element validation is deferred to first use
   * (`loadCompiled`), so hydration stays a cheap index load.
   */
  private storeRestoredCompiled(
    key: DerivedCacheKey,
    packed: PackedCompiledInk,
  ): void {
    this.storeSlot(key, packed);
  }

  private storeSlot(key: DerivedCacheKey, packed: PackedCompiledInk): void {
    const mapKey = SurfaceDerivedCache.mapKey(key);
    const existing = this.compiled.get(mapKey);
    if (existing !== undefined) this.dropSlot(mapKey);
    const bytes = packedCompiledByteLength(packed);
    this.compiled.set(mapKey, { key, packed, bytes });
    this.compiledBytes += bytes;
    // Evict oldest entries until BOTH budgets fit, deterministically. An
    // entry larger than the whole byte budget evicts itself.
    while (
      this.compiledBytes > this.maxCompiledBytes ||
      this.compiled.size > this.maxCompiledEntries
    ) {
      const oldest = this.compiled.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const overBytes = this.compiledBytes > this.maxCompiledBytes;
      this.dropSlot(oldest);
      this.stats.compiledEvictions += 1;
      if (overBytes) this.stats.byteEvictions += 1;
    }
    this.refreshStats();
  }

  private dropSlot(mapKey: string): void {
    const slot = this.compiled.get(mapKey);
    if (slot === undefined) return;
    this.compiled.delete(mapKey);
    this.compiledBytes = Math.max(0, this.compiledBytes - slot.bytes);
  }

  /** Drop one object's entries (on canonical mutation). */
  invalidateObject(documentId: string, objectId: string): void {
    let dropped = 0;
    for (const [k, v] of [...this.bounds]) {
      if (v.key.documentId === documentId && v.key.objectId === objectId) {
        this.bounds.delete(k);
        dropped += 1;
      }
    }
    for (const [k, v] of [...this.compiled]) {
      if (v.key.documentId === documentId && v.key.objectId === objectId) {
        this.dropSlot(k);
        dropped += 1;
      }
    }
    if (dropped > 0) this.stats.invalidations += dropped;
    this.refreshStats();
  }

  /** Drop a whole document (on close/evict). */
  invalidateDocument(documentId: string): void {
    let dropped = 0;
    for (const [k, v] of [...this.bounds]) {
      if (v.key.documentId === documentId) {
        this.bounds.delete(k);
        dropped += 1;
      }
    }
    for (const [k, v] of [...this.compiled]) {
      if (v.key.documentId === documentId) {
        this.dropSlot(k);
        dropped += 1;
      }
    }
    if (dropped > 0) this.stats.invalidations += dropped;
    this.refreshStats();
  }

  clear(): void {
    this.bounds.clear();
    this.compiled.clear();
    this.compiledBytes = 0;
    this.refreshStats();
  }

  /** Bounds entries for a revision, as a plain list (persistence input). */
  boundsEntries(revision?: string): CachedDerivedBounds[] {
    const out: CachedDerivedBounds[] = [];
    for (const entry of this.bounds.values()) {
      if (revision !== undefined && entry.key.revision !== revision) continue;
      out.push(entry);
    }
    return out;
  }

  /**
   * Compiled entries for a revision, as a plain list (persistence input).
   * Entries are cache-owned; callers must not detach their buffers.
   */
  compiledEntries(revision?: string): CachedCompiledGeometry[] {
    const out: CachedCompiledGeometry[] = [];
    for (const entry of this.compiled.values()) {
      if (revision !== undefined && entry.key.revision !== revision) continue;
      out.push({ key: entry.key, packed: entry.packed });
    }
    return out;
  }

  /**
   * Serialize entries into one compact little-endian binary container
   * (typed arrays verbatim — never base64, never JSON stringification of
   * geometry). `revision`, when given, filters to that canonical
   * revision so retired revisions are never re-persisted. The resulting
   * container never exceeds the cache's packed byte budget for geometry
   * (entries are retained within the budget by construction).
   */
  serializeBinary(revision?: string): Uint8Array {
    return serializeDerivedCacheBinary({
      bounds: this.boundsEntries(revision),
      compiled: this.compiledEntries(revision),
    });
  }

  /**
   * Restore entries from a binary container. Stale compiler/format
   * versions abort the whole restore (the container belongs to another
   * era); a structurally malformed container also aborts. Individual
   * payload validation is DEFERRED to first use (`loadCompiled`) so
   * async OPFS/Tauri hydration stays a cheap index load instead of a
   * whole-document element walk — a corrupt payload is a lazy, safe
   * miss that never yields partial derived geometry. Never throws.
   */
  restoreBinary(bytes: Uint8Array, revision?: string): number {
    let staged: {
      bounds: CachedDerivedBounds[];
      compiled: CachedCompiledGeometry[];
    };
    try {
      const reader = new BinaryReader(bytes);
      if (reader.u32() !== DERIVED_CACHE_MAGIC) return 0;
      if (reader.u32() !== DERIVED_CACHE_VERSION) return 0;
      const count = reader.u32();
      staged = { bounds: [], compiled: [] };
      for (let i = 0; i < count; i++) {
        const kind = reader.u8();
        const key = readKey(reader);
        if (!isDerivedCacheKeyCurrent(key)) return 0;
        if (revision !== undefined && key.revision !== revision) return 0;
        if (kind === 0) {
          const present = reader.u8();
          if (present === 0) {
            staged.bounds.push({ key, bounds: null });
            continue;
          }
          if (present !== 1) return 0;
          const bounds: Bounds = {
            x: reader.f64(),
            y: reader.f64(),
            width: reader.f64(),
            height: reader.f64(),
          };
          if (!isBoundsLike(bounds)) return 0;
          staged.bounds.push({ key, bounds });
          continue;
        }
        if (kind !== 1) return 0;
        // Structural parse only: the typed-array lengths/counts are
        // checked by the reader; element validation is lazy.
        staged.compiled.push({ key, packed: readPackedCompiledInk(reader) });
      }
      if (!reader.done) return 0;
    } catch {
      return 0;
    }
    let restored = 0;
    for (const entry of staged.bounds) {
      this.storeBounds(entry.key, entry.bounds);
      restored += 1;
    }
    for (const entry of staged.compiled) {
      this.storeRestoredCompiled(entry.key, entry.packed);
      restored += 1;
    }
    return restored;
  }
}

/**
 * Build one binary container from explicit entry lists. Shared by the
 * in-memory cache and the off-main-thread persistence worker; packet
 * arrays are written verbatim.
 */
export function serializeDerivedCacheBinary(input: {
  readonly bounds: readonly CachedDerivedBounds[];
  readonly compiled: readonly (
    | CachedCompiledGeometry
    | { readonly key: DerivedCacheKey; readonly packed: PackedCompiledInk }
  )[];
}): Uint8Array {
  const writer = new BinaryWriter();
  writer.u32(DERIVED_CACHE_MAGIC);
  writer.u32(DERIVED_CACHE_VERSION);
  writer.u32(input.bounds.length + input.compiled.length);
  for (const entry of input.bounds) {
    writer.u8(0);
    writeKey(writer, entry.key);
    if (entry.bounds === null || !isBoundsLike(entry.bounds)) {
      writer.u8(0);
    } else {
      writer.u8(1);
      writer.f64(entry.bounds.x);
      writer.f64(entry.bounds.y);
      writer.f64(entry.bounds.width);
      writer.f64(entry.bounds.height);
    }
  }
  for (const entry of input.compiled) {
    writer.u8(1);
    writeKey(writer, entry.key);
    writePackedCompiledInk(writer, entry.packed);
  }
  return writer.finish();
}

/**
 * Encode ONE packed entry as a standalone binary record (truly-lazy
 * per-entry file). Single-entry container (count=1, no bounds) so the
 * existing structural reader validates it without new codec.
 */
export function encodeDerivedCacheEntry(
  key: DerivedCacheKey,
  packed: PackedCompiledInk,
): Uint8Array {
  return serializeDerivedCacheBinary({
    bounds: [],
    compiled: [{ key, packed }],
  });
}

/**
 * Decode ONE per-entry record; null means stale/corrupt → safe miss.
 * Validates document/object/revision + compiler/schema versions.
 */
export function decodeDerivedCacheEntry(
  bytes: Uint8Array,
  expectedDocumentId: string,
  expectedObjectId: string,
  expectedRevision: string,
): { key: DerivedCacheKey; packed: PackedCompiledInk } | null {
  try {
    const reader = new BinaryReader(bytes);
    if (reader.u32() !== DERIVED_CACHE_MAGIC) return null;
    if (reader.u32() !== DERIVED_CACHE_VERSION) return null;
    if (reader.u32() !== 1) return null;
    if (reader.u8() !== 1) return null;
    const key = readKey(reader);
    if (!isDerivedCacheKeyCurrent(key)) return null;
    if (
      key.documentId !== expectedDocumentId ||
      key.objectId !== expectedObjectId ||
      key.revision !== expectedRevision
    ) {
      return null;
    }
    const packed = readPackedCompiledInk(reader);
    if (!reader.done) return null;
    if (validatePackedCompiledInk(packed) !== null) return null;
    return { key, packed };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Binary container codec (portable: DataView + typed arrays only)
// ---------------------------------------------------------------------------

class BinaryWriter {
  #buffer = new Uint8Array(1024);
  #view = new DataView(this.#buffer.buffer);
  #length = 0;

  #ensure(bytes: number): void {
    if (this.#length + bytes <= this.#buffer.length) return;
    let next = this.#buffer.length * 2;
    while (next < this.#length + bytes) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.#buffer.subarray(0, this.#length));
    this.#buffer = grown;
    this.#view = new DataView(grown.buffer);
  }

  u8(value: number): void {
    this.#ensure(1);
    this.#view.setUint8(this.#length, value & 0xff);
    this.#length += 1;
  }

  u16(value: number): void {
    this.#ensure(2);
    this.#view.setUint16(this.#length, value & 0xffff, true);
    this.#length += 2;
  }

  u32(value: number): void {
    this.#ensure(4);
    this.#view.setUint32(this.#length, value >>> 0, true);
    this.#length += 4;
  }

  i32(value: number): void {
    this.#ensure(4);
    this.#view.setInt32(this.#length, value | 0, true);
    this.#length += 4;
  }

  f64(value: number): void {
    this.#ensure(8);
    this.#view.setFloat64(this.#length, value, true);
    this.#length += 8;
  }

  /** UTF-16 code units (exact JS string round trip, no encoder globals). */
  utf16(value: string): void {
    this.u32(value.length);
    for (let i = 0; i < value.length; i++) this.u16(value.charCodeAt(i));
  }

  bytes(value: Uint8Array): void {
    this.#ensure(value.length);
    this.#buffer.set(value, this.#length);
    this.#length += value.length;
  }

  finish(): Uint8Array {
    return this.#buffer.slice(0, this.#length);
  }
}

class BinaryReader {
  readonly #view: DataView;
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(
      bytes.buffer as ArrayBuffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
  }

  #require(bytes: number): void {
    if (this.#offset + bytes > this.#bytes.byteLength) {
      throw new Error('derived-cache container truncated');
    }
  }

  u8(): number {
    this.#require(1);
    const value = this.#view.getUint8(this.#offset);
    this.#offset += 1;
    return value;
  }

  u16(): number {
    this.#require(2);
    const value = this.#view.getUint16(this.#offset, true);
    this.#offset += 2;
    return value;
  }

  u32(): number {
    this.#require(4);
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  i32(): number {
    this.#require(4);
    const value = this.#view.getInt32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  f64(): number {
    this.#require(8);
    const value = this.#view.getFloat64(this.#offset, true);
    this.#offset += 8;
    return value;
  }

  utf16(): string {
    const length = this.u32();
    this.#require(length * 2);
    let out = '';
    const CHUNK = 0x2000;
    const codes: number[] = new Array(Math.min(length, CHUNK));
    let written = 0;
    while (written < length) {
      const span = Math.min(CHUNK, length - written);
      for (let i = 0; i < span; i++) codes[i] = this.u16();
      out += String.fromCharCode(...codes.slice(0, span));
      written += span;
    }
    return out;
  }

  /** Copy bytes out (fresh aligned buffer; container memory stays private). */
  bytes(length: number): Uint8Array {
    this.#require(length);
    const out = this.#bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return out;
  }

  get done(): boolean {
    return this.#offset === this.#bytes.byteLength;
  }
}

function writeKey(writer: BinaryWriter, key: DerivedCacheKey): void {
  writer.utf16(key.documentId);
  writer.utf16(key.objectId);
  writer.utf16(key.revision);
  writer.u32(key.compilerVersion);
  writer.u32(key.cacheVersion);
}

function readKey(reader: BinaryReader): DerivedCacheKey {
  return {
    documentId: reader.utf16(),
    objectId: reader.utf16(),
    revision: reader.utf16(),
    compilerVersion: reader.u32(),
    cacheVersion: reader.u32(),
  };
}

const PACKED_F64_FIELDS = [
  'nodeXY',
  'nodeWidth',
  'nodePressure',
  'nodeTiltXY',
  'nodeTwist',
  'nodeDt',
  'nodeU',
  'nodeArc',
  'nodeCorner',
  'polygonXY',
  'meshLeftXY',
  'meshRightXY',
  'meshRingXY',
  'leftFanXY',
  'rightFanXY',
  'boundsXYWH',
  'dotXY',
  'dotAttrs',
] as const;

const PACKED_U8_FIELDS = ['nodeFlags', 'startsRun'] as const;
const PACKED_U32_FIELDS = ['leftFanOffsets', 'rightFanOffsets'] as const;
const PACKED_I32_FIELDS = ['nodeSegment'] as const;

type PackedF64Field = (typeof PACKED_F64_FIELDS)[number];
type PackedU8Field = (typeof PACKED_U8_FIELDS)[number];
type PackedU32Field = (typeof PACKED_U32_FIELDS)[number];
type PackedI32Field = (typeof PACKED_I32_FIELDS)[number];

function writePackedCompiledInk(
  writer: BinaryWriter,
  packed: PackedCompiledInk,
): void {
  writer.u32(PACKED_INK_TRANSPORT_VERSION);
  writer.u32(packed.nodeCount);
  writer.u32(packed.controlCount);
  writer.i32(packed.cornerCount);
  writer.u32(packed.segmentCount);
  writer.u8(packed.dotPresent);
  if (packed.nodeExtras === undefined) {
    writer.u8(0);
  } else {
    writer.u8(1);
    writer.utf16(JSON.stringify(packed.nodeExtras));
  }
  const record = packed as unknown as Record<string, ArrayBufferView>;
  for (const field of PACKED_F64_FIELDS) writeView(writer, record[field]!);
  for (const field of PACKED_U8_FIELDS) writeView(writer, record[field]!);
  for (const field of PACKED_U32_FIELDS) writeView(writer, record[field]!);
  for (const field of PACKED_I32_FIELDS) writeView(writer, record[field]!);
}

function writeView(writer: BinaryWriter, view: ArrayBufferView): void {
  const bytes = new Uint8Array(
    view.buffer as ArrayBuffer,
    view.byteOffset,
    view.byteLength,
  );
  writer.u32(bytes.length);
  writer.bytes(bytes);
}

function readView<
  T extends Float64Array | Uint8Array | Uint32Array | Int32Array,
>(
  reader: BinaryReader,
  Ctor: new (buffer: ArrayBuffer, byteOffset: number, length: number) => T,
  bytesPerElement: number,
): T {
  const byteLength = reader.u32();
  if (byteLength % bytesPerElement !== 0) {
    throw new Error('derived-cache packed field misaligned');
  }
  const bytes = reader.bytes(byteLength);
  return new Ctor(bytes.buffer as ArrayBuffer, 0, byteLength / bytesPerElement);
}

function readPackedCompiledInk(reader: BinaryReader): PackedCompiledInk {
  const version = reader.u32();
  const nodeCount = reader.u32();
  const controlCount = reader.u32();
  const cornerCount = reader.i32();
  const segmentCount = reader.u32();
  const dotPresent = reader.u8();
  const hasExtras = reader.u8();
  let nodeExtras: (Record<string, unknown> | undefined)[] | undefined;
  if (hasExtras === 1) {
    const parsed: unknown = JSON.parse(reader.utf16());
    if (!Array.isArray(parsed)) throw new Error('bad node extras');
    nodeExtras = parsed as (Record<string, unknown> | undefined)[];
  } else if (hasExtras !== 0) {
    throw new Error('bad node extras flag');
  }
  const f64 = (): Float64Array => readView(reader, Float64Array, 8);
  const u8 = (): Uint8Array => readView(reader, Uint8Array, 1);
  const u32 = (): Uint32Array => readView(reader, Uint32Array, 4);
  const i32 = (): Int32Array => readView(reader, Int32Array, 4);
  const result: Record<string, unknown> = {
    version,
    nodeCount,
    controlCount,
    cornerCount,
    segmentCount,
    dotPresent,
  };
  for (const field of PACKED_F64_FIELDS) result[field] = f64();
  for (const field of PACKED_U8_FIELDS) result[field] = u8();
  for (const field of PACKED_U32_FIELDS) result[field] = u32();
  for (const field of PACKED_I32_FIELDS) result[field] = i32();
  if (nodeExtras !== undefined) result.nodeExtras = nodeExtras;
  return result as unknown as PackedCompiledInk;
}

// Compile-time guard: the field tables cover every packed numeric array
// (a new PackedCompiledInk field must be added to the codec or the type
// assignment below fails, keeping the binary container in lockstep).
const PACKED_FIELD_TYPE_GUARD: readonly Exclude<
  keyof PackedCompiledInk,
  | 'version'
  | 'nodeCount'
  | 'controlCount'
  | 'cornerCount'
  | 'segmentCount'
  | 'dotPresent'
  | 'nodeExtras'
  | PackedF64Field
  | PackedU8Field
  | PackedU32Field
  | PackedI32Field
>[] = [];
void PACKED_FIELD_TYPE_GUARD;
