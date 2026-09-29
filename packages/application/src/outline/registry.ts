/**
 * Owner-scoped outline extractors with a bounded per-document revision cache.
 * A document identity is required for caching; callers without one still get
 * fresh rows. Returned rows are frozen, and the panel invalidates its document
 * slot when that document closes.
 */

import { definePlugin } from '@froglight/runtime';
import { outlineRegistryToken } from './token.js';
import { firstPartyDocumentFeatures } from '../document-features.js';
export { outlineRegistryToken } from './token.js';
import {
  ErrorCodes,
  FroglightError,
  stableStringify,
  type DocumentKindId,
} from '@froglight/foundation';
import type {
  DocumentOutlineEntry,
  OutlineExtractInput,
  OutlineExtractor,
} from './types.js';

/** The authoritative composition of first-party outline extractors. */
export const firstPartyOutlineExtractors: readonly OutlineExtractor[] =
  Object.freeze(firstPartyDocumentFeatures.flatMap((feature) => feature.outline ? [feature.outline] : []));

/**
 * Maximum number of (kind, documentIdentity) slots retained by
 * `InMemoryOutlineRegistry`. LRU-evicted, see the module contract note.
 */
export const MAX_OUTLINE_CACHE_SLOTS = 64;

/** Cumulative cache observability for the outline panel and tests. */
export interface OutlineCacheStats {
  /** Cache reuses since construction. */
  readonly hits: number;
  /** Full extractor runs since construction (including uncacheable runs). */
  readonly misses: number;
  /** Current number of retained slots. */
  readonly size: number;
  /** The bound from `MAX_OUTLINE_CACHE_SLOTS`. */
  readonly capacity: number;
}

export interface OutlineRegistry {
  /**
   * Register an extractor.
   * @throws `FroglightError` with code `DUPLICATE_OUTLINE_EXTRACTOR` when
   * `kindId` is already registered.
   */
  register(extractor: OutlineExtractor): { dispose(): void };
  /**
   * Resolve an extractor.
   * @throws `FroglightError` with code `UNKNOWN_OUTLINE_KIND` when absent.
   */
  get(kindId: DocumentKindId): OutlineExtractor;
  /** Whether this document kind contributes an outline, even when empty. */
  supports(kindId: DocumentKindId): boolean;
  /** All registered extractors. */
  list(): readonly OutlineExtractor[];
  /**
   * Extract with per-(kind, documentIdentity) revision caching. The explicit
   * `revision` argument wins over `input.revision`; both compare with `===`.
   * Pass `input.documentIdentity` (document/resource id) to scope the slot
   * to one document. Calls without a real identity skip the cache. The
   * returned array (and each row) is frozen; never
   * mutate it.
   *
   * Panel obligations: always pass identity+revision, invalidate on close.
   */
  getOutline(
    kindId: DocumentKindId,
    model: unknown,
    revision?: string | number,
    input?: Omit<OutlineExtractInput, 'model' | 'revision'>,
  ): readonly DocumentOutlineEntry[];
  /**
   * Drop cached rows. With no arguments the whole cache is cleared; with a
   * `kindId` every document slot of that kind is dropped; with both, only
   * that document's slot is dropped. A lone `documentIdentity` drops that
   * document's slots across kinds. Counters from `stats()` are preserved.
   */
  invalidate(kindId?: DocumentKindId, documentIdentity?: string): void;
  /** Cumulative hit/miss counters plus the current size and capacity. */
  stats(): OutlineCacheStats;
}

function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function fallbackKey(model: unknown): string | null {
  try {
    return `hash:${fnv1aHex(stableStringify(model))}`;
  } catch {
    return null;
  }
}

interface CacheSlot {
  key: string | number;
  entries: readonly DocumentOutlineEntry[];
}

const CACHE_SEPARATOR = '\0';

function cacheKeyFor(kindKey: string, documentIdentity: string): string {
  return `${kindKey}${CACHE_SEPARATOR}${documentIdentity}`;
}

function freezeOutlineEntries(
  entries: readonly DocumentOutlineEntry[],
): readonly DocumentOutlineEntry[] {
  for (const entry of entries) {
    if (!Object.isFrozen(entry)) Object.freeze(entry);
  }
  if (!Object.isFrozen(entries)) Object.freeze(entries);
  return entries;
}

export class InMemoryOutlineRegistry implements OutlineRegistry {
  readonly #extractors = new Map<string, OutlineExtractor>();
  readonly #cache = new Map<string, CacheSlot>();
  #hits = 0;
  #misses = 0;

  #deleteKindCache(kindKey: string): void {
    const prefix = `${kindKey}${CACHE_SEPARATOR}`;
    for (const key of [...this.#cache.keys()]) {
      if (key.startsWith(prefix)) this.#cache.delete(key);
    }
  }

  #storeSlot(cacheKey: string, slot: CacheSlot): void {
    // LRU bound: evict the least-recently-used head when full.
    // Refreshing an existing key keeps the size; only new keys can evict.
    if (!this.#cache.has(cacheKey) && this.#cache.size >= MAX_OUTLINE_CACHE_SLOTS) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
    this.#cache.set(cacheKey, slot);
  }

  #touchSlot(cacheKey: string, slot: CacheSlot): void {
    // Move the hit to the tail so eviction drops the least-recently-used.
    this.#cache.delete(cacheKey);
    this.#cache.set(cacheKey, slot);
  }

  register(extractor: OutlineExtractor): { dispose(): void } {
    const key = String(extractor.kindId);
    if (this.#extractors.has(key)) {
      throw new FroglightError(
        ErrorCodes.DUPLICATE_OUTLINE_EXTRACTOR,
        `outline extractor already registered: ${key}`,
      );
    }
    this.#extractors.set(key, extractor);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.#extractors.get(key) === extractor) this.#extractors.delete(key);
        this.#deleteKindCache(key);
      },
    };
  }

  get(kindId: DocumentKindId): OutlineExtractor {
    const extractor = this.#extractors.get(String(kindId));
    if (extractor === undefined) {
      throw new FroglightError(
        ErrorCodes.UNKNOWN_OUTLINE_KIND,
        `unknown outline kind: ${String(kindId)}`,
      );
    }
    return extractor;
  }

  supports(kindId: DocumentKindId): boolean {
    const extractor = this.#extractors.get(String(kindId));
    return extractor !== undefined && extractor.available !== false;
  }

  list(): readonly OutlineExtractor[] {
    return [...this.#extractors.values()];
  }

  getOutline(
    kindId: DocumentKindId,
    model: unknown,
    revision?: string | number,
    input?: Omit<OutlineExtractInput, 'model' | 'revision'>,
  ): readonly DocumentOutlineEntry[] {
    const kindKey = String(kindId);
    const extractor = this.get(kindId);
    const identity = input?.documentIdentity;
    const effective = revision ?? fallbackKey(model);
    const cacheKey = identity ? cacheKeyFor(kindKey, identity) : null;
    const slot = cacheKey === null ? undefined : this.#cache.get(cacheKey);
    if (cacheKey !== null && slot !== undefined && effective !== null && slot.key === effective) {
      this.#hits += 1;
      this.#touchSlot(cacheKey, slot);
      return slot.entries;
    }
    const entries = extractor.extract({ ...input, model, ...(revision !== undefined ? { revision } : {}) });
    const frozen = freezeOutlineEntries(entries);
    // Extraction is available without an identity, but cache slots require
    // a real document id so revisions cannot be shared across documents.
    if (effective === null || cacheKey === null) {
      this.#misses += 1;
      return frozen;
    }
    this.#misses += 1;
    this.#storeSlot(cacheKey, { key: effective, entries: frozen });
    return frozen;
  }

  invalidate(kindId?: DocumentKindId, documentIdentity?: string): void {
    if (kindId === undefined && !documentIdentity) {
      this.#cache.clear();
      return;
    }
    if (kindId !== undefined && documentIdentity) {
      this.#cache.delete(cacheKeyFor(String(kindId), documentIdentity));
      return;
    }
    if (kindId !== undefined) {
      this.#deleteKindCache(String(kindId));
      return;
    }
    const suffix = `${CACHE_SEPARATOR}${documentIdentity}`;
    for (const key of [...this.#cache.keys()]) {
      if (key.endsWith(suffix)) this.#cache.delete(key);
    }
  }

  stats(): OutlineCacheStats {
    return {
      hits: this.#hits,
      misses: this.#misses,
      size: this.#cache.size,
      capacity: MAX_OUTLINE_CACHE_SLOTS,
    };
  }
}

/** Runtime binding: a fresh registry instance, owned by the fiber. */
export const outlineRegistryPlugin = definePlugin({
  id: 'froglight.outline-registry',
  activate: (ctx) => {
    ctx.provide(outlineRegistryToken, new InMemoryOutlineRegistry());
  },
});

/**
 * First-party extractors; disabling the slot removes all outline rows.
 *
 * This bundle registers the first-party extractor composition together.
 * Consumers resolve the registry through `outlineRegistryToken` rather
 * than depending on this bundle's shape.
 */
export const outlineExtractorsPlugin = definePlugin({
  id: 'froglight.outline-extractors',
  requirements: { requires: [outlineRegistryToken] },
  activate: (ctx) => {
    const registry = ctx.require(outlineRegistryToken);
    for (const extractor of firstPartyOutlineExtractors) {
      ctx.effect(() => registry.register(extractor).dispose);
    }
  },
});
