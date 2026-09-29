/**
 * Disposable Surface open-time metadata (cold-open repair).
 *
 * Decode-time Ink bounds seeds flow `decodeSurfacePayload()` →
 * document-kind `openMetadata` → `DocumentSession.openMetadata` →
 * `mountInkSurface({ seedBounds })` → `seedIndexesFromDecode()`, so
 * opening a dense Ink document never rescans every sample solely to
 * rebuild spatial bounds.
 *
 * Seeds are DERIVED, never canonical: they are held in memory only, never
 * persisted into the Surface payload, and never projected into the
 * metadata index. Stale or malformed seeds are ignored (callers fall back
 * to normal derivation), never trusted silently.
 */

import type { Bounds } from './geometry.js';
import { DOCUMENT_CONTENT_REVISION_KEY } from '../documents.js';

/** `openMetadata` key carrying whole-document Ink bounds seeds. */
export const SURFACE_SEED_BOUNDS_KEY = 'surface.seedBounds';

/**
 * `openMetadata` key carrying per-page Ink bounds seeds for notebooks
 * (`ReadonlyMap<pageId, seedBounds>`).
 */
export const SURFACE_SEED_BOUNDS_BY_PAGE_KEY = 'surface.seedBoundsByPage';

/**
 * `openMetadata` key carrying the canonical-bytes checksum (FNV-1a hex,
 * see `checksumOf`): the legacy derived-cache revision fingerprint,
 * written by document-kind decoders before the session layer owned the
 * revision. Decoders no longer write this; readers prefer
 * `DOCUMENT_CONTENT_REVISION_KEY` and accept this only as a fallback
 * (e.g. direct `kind.decode` calls in tests, outside a session).
 */
export const SURFACE_CANONICAL_CHECKSUM_KEY = 'surface.canonicalChecksum';

/**
 * Non-canonical metadata accompanying one opened Surface model: derived
 * bounds seeds for Ink strokes, computed during the decode pass.
 */
export interface SurfaceOpenMetadata {
  readonly seedBounds?: ReadonlyMap<string, Bounds | null>;
}

/** Structural check for one disposable bounds value (finite, non-negative size). */
export function isBoundsLike(value: unknown): value is Bounds {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.x === 'number' &&
    Number.isFinite(b.x) &&
    typeof b.y === 'number' &&
    Number.isFinite(b.y) &&
    typeof b.width === 'number' &&
    Number.isFinite(b.width) &&
    (b.width as number) >= 0 &&
    typeof b.height === 'number' &&
    Number.isFinite(b.height) &&
    (b.height as number) >= 0
  );
}

/**
 * Structural validation for a decode-time bounds seed map (no sample
 * scans): a `Map` with non-empty string keys and `Bounds | null` values.
 * Anything else (absent, wrong container, malformed entries) is unusable
 * and must fall back to normal derivation.
 */
export function isValidSeedBounds(
  value: unknown,
): value is ReadonlyMap<string, Bounds | null> {
  if (!(value instanceof Map)) return false;
  for (const [key, bounds] of value) {
    if (typeof key !== 'string' || key.length === 0) return false;
    if (bounds !== null && !isBoundsLike(bounds)) return false;
  }
  return true;
}

/**
 * Read whole-document Ink seeds from kind/session open metadata. Returns
 * the seed map when structurally valid, else null (caller falls back to
 * normal derivation).
 */
export function seedBoundsFromOpenMetadata(
  openMetadata: Readonly<Record<string, unknown>> | null | undefined,
): ReadonlyMap<string, Bounds | null> | null {
  if (openMetadata === null || openMetadata === undefined) return null;
  const seeds = openMetadata[SURFACE_SEED_BOUNDS_KEY];
  return isValidSeedBounds(seeds) ? seeds : null;
}

/**
 * Read the canonical checksum from kind/session open metadata. Returns
 * the checksum string when present and well-formed, else null (the
 * reopen cache is then unusable and decode seeds apply directly).
 *
 * Legacy path: prefer `contentRevisionFromOpenMetadata` (session-owned
 * revision token). This stays for direct `kind.decode` calls outside a
 * session and old tests.
 */
export function checksumFromOpenMetadata(
  openMetadata: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
  if (openMetadata === null || openMetadata === undefined) return null;
  const checksum = openMetadata[SURFACE_CANONICAL_CHECKSUM_KEY];
  return typeof checksum === 'string' && checksum.length > 0 ? checksum : null;
}

/**
 * Read the canonical content revision for derived-cache validation.
 * Prefers the session-owned token (`DOCUMENT_CONTENT_REVISION_KEY`,
 * computed once when bytes enter the session layer) and falls back to
 * the legacy kind-written checksum. Null means unusable — decode seeds
 * apply directly and no cache entries validate.
 */
export function contentRevisionFromOpenMetadata(
  openMetadata: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
  if (openMetadata === null || openMetadata === undefined) return null;
  const revision = openMetadata[DOCUMENT_CONTENT_REVISION_KEY];
  if (typeof revision === 'string' && revision.length > 0) return revision;
  return checksumFromOpenMetadata(openMetadata);
}

/**
 * Read one notebook page's Ink seeds from kind/session open metadata.
 * Returns the page's seed map when structurally valid, else null.
 */
export function pageSeedBoundsFromOpenMetadata(
  openMetadata: Readonly<Record<string, unknown>> | null | undefined,
  pageId: string,
): ReadonlyMap<string, Bounds | null> | null {
  if (openMetadata === null || openMetadata === undefined) return null;
  const byPage = openMetadata[SURFACE_SEED_BOUNDS_BY_PAGE_KEY];
  if (!(byPage instanceof Map)) return null;
  const seeds = byPage.get(pageId);
  return isValidSeedBounds(seeds) ? seeds : null;
}
