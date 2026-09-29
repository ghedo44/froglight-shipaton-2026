/**
 * Shared derived-geometry cache for the smooth-stroke pipeline.
 *
 * Committed strokes must compile only when their canonical data changes:
 * camera pans must not re-fit curves, and rendering, culling,
 * hit-testing, selection, and erasing must share one geometry truth
 * instead of each compiling the same stroke independently. This module is
 * the seam: a small generic memo keyed by object identity plus a caller
 * fingerprint, with clear invalidation (any fingerprint change recompiles;
 * entries die with their records via WeakMap).
 *
 * Headless, DOM-free. The cache never mutates canonical data and never
 * retains records past their own lifetime.
 */

/** Compute-on-miss callback for a cache entry. */
export type DerivedCompute<T> = () => T;

/**
 * Get the cached value for `key`, computing and storing it when the
 * fingerprint differs from the stored one. Fingerprints must change
 * whenever the inputs that `compute` reads change; fingerprints are
 * compared by strict equality.
 */
export function cachedDerived<T extends object>(
  cache: WeakMap<object, { fingerprint: string; value: T }>,
  key: object,
  fingerprint: string,
  compute: DerivedCompute<T>,
): T {
  const stored = cache.get(key);
  if (stored !== undefined && stored.fingerprint === fingerprint) {
    return stored.value;
  }
  const value = compute();
  cache.set(key, { fingerprint, value });
  return value;
}

/** Drop one record's entry (explicit invalidation on structural edits). */
export function invalidateDerived(
  cache: WeakMap<object, { fingerprint: string; value: unknown }>,
  key: object,
): void {
  cache.delete(key);
}
