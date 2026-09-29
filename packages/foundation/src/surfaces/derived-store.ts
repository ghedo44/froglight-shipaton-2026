import { inkRegion, regionBounds } from './ink/fragments.js';
/**
 * Model-owned derived geometry cache (Slice 6).
 *
 * Bounds and compiled Ink geometry keyed by object id with explicit
 * mutation revision. Unchanged objects hit O(1) without rescanning
 * samples or hashing fingerprints; canonical mutation invalidates only
 * affected ids.
 *
 * Ink bounds extraction iterates raw `record.points` directly without
 * allocating `InkSample[]`/`Point[]`.
 */

import { finiteNumber, type Bounds } from './geometry.js';
import { INK_DEFAULT_WIDTH } from './ink/brush.js';
import { resolveBrushSpec, brushPresetForKind } from './ink/brush.js';
import type { InkBrushSpec } from './ink/brush.js';
import type { SurfaceObjectRecord } from './model.js';

export interface DerivedStoreStats {
  boundsHits: number;
  boundsMisses: number;
  /** Raw point scans for bounds (misses only, never per-frame hits). */
  boundsScans: number;
  compiledHits: number;
  compiledMisses: number;
  invalidations: number;
  /** Bounds entries shifted by rigid translation (no point scans). */
  boundsTranslates: number;
  /** Bounds entries seeded from the decode pass (no second scan). */
  boundsSeeded: number;
}

function inkWidthOfRecord(record: SurfaceObjectRecord): number {
  const width = finiteNumber(record.width);
  return width !== null && width > 0 ? width : INK_DEFAULT_WIDTH;
}

function resolveBrushForRecord(record: SurfaceObjectRecord): InkBrushSpec {
  const stored =
    typeof record.brush === 'object' && record.brush !== null
      ? (record.brush as Record<string, unknown>)
      : {};
  const kindRaw = stored.kind;
  const kind =
    typeof kindRaw === 'string' &&
    ['ball', 'fountain', 'brush', 'pencil', 'highlighter'].includes(kindRaw)
      ? kindRaw
      : 'ball';
  return resolveBrushSpec(
    {
      ...(stored as object),
      kind: kind as InkBrushSpec['kind'],
      size: inkWidthOfRecord(record),
    } as never,
    brushPresetForKind(kind as InkBrushSpec['kind']),
  );
}

function halfWidthForRecord(record: SurfaceObjectRecord): number {
  const brush = resolveBrushForRecord(record);
  const pressureMax = brush.pressure.enabled
    ? Math.max(brush.pressure.maxFactor, 0)
    : 1;
  return Math.max((brush.size / 2) * pressureMax * (1 + brush.tiltEffect), 0);
}

/**
 * Cheap Ink bounds: single pass over raw `record.points`, no
 * `InkSample[]`/`Point[]` allocation, no fingerprint hash.
 */
export function cheapInkBounds(record: SurfaceObjectRecord): Bounds | null {
  const region = inkRegion(record);
  if (region !== null) return regionBounds(region);
  const points = (record as Record<string, unknown>).points;
  if (!Array.isArray(points) || points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let usable = false;
  for (const raw of points) {
    if (typeof raw !== 'object' || raw === null) continue;
    const s = raw as Record<string, unknown>;
    const x = typeof s.x === 'number' && Number.isFinite(s.x) ? s.x : null;
    const y = typeof s.y === 'number' && Number.isFinite(s.y) ? s.y : null;
    if (x === null || y === null) continue;
    usable = true;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!usable) return null;
  const pad = halfWidthForRecord(record);
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}

/** Cheap sized-box bounds without allocation beyond the result. */
export function cheapSizedBounds(record: SurfaceObjectRecord): Bounds | null {
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  const width = finiteNumber(record.width);
  const height = finiteNumber(record.height);
  if (x === null || y === null || width === null || height === null) {
    return null;
  }
  if (width < 0 || height < 0) return null;
  return { x, y, width, height };
}

interface BoundsEntry {
  ref: object;
  bounds: Bounds | null;
}

export class SurfaceDerivedGeometryStore {
  private readonly boundsById = new Map<string, BoundsEntry>();
  private readonly stats: DerivedStoreStats = {
    boundsHits: 0,
    boundsMisses: 0,
    boundsScans: 0,
    compiledHits: 0,
    compiledMisses: 0,
    invalidations: 0,
    boundsTranslates: 0,
    boundsSeeded: 0,
  };

  statsSnapshot(): DerivedStoreStats {
    return { ...this.stats };
  }

  clear(): void {
    this.boundsById.clear();
  }

  invalidate(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.boundsById.delete(id)) {
        // Deleted cached entry; counts once per id below.
      }
    }
    if (ids.length > 0) this.stats.invalidations += ids.length;
  }

  remove(id: string): void {
    this.boundsById.delete(id);
  }

  /**
   * Geometry-preserving bounds translation (item 1): shift a cached entry
   * by `(dx,dy)` without rescanning canonical samples. Returns false when
   * no cached entry exists (caller falls back to a single miss scan).
   * Explicitly distinct from `invalidate()` (geometry mutation).
   */
  translate(id: string, dx: number, dy: number): boolean {
    if (dx === 0 && dy === 0) return this.boundsById.has(id);
    const entry = this.boundsById.get(id);
    if (entry === undefined) return false;
    if (entry.bounds !== null) {
      entry.bounds = {
        x: entry.bounds.x + dx,
        y: entry.bounds.y + dy,
        width: entry.bounds.width,
        height: entry.bounds.height,
      };
    }
    // The canonical record object was mutated in place (same ref), so the
    // entry stays valid — no invalidation, no rescan.
    this.stats.boundsTranslates += 1;
    return true;
  }

  /** Translate several cached bounds (counts per id). */
  translateMany(ids: readonly string[], dx: number, dy: number): number {
    let translated = 0;
    for (const id of ids) {
      if (this.translate(id, dx, dy)) translated += 1;
    }
    return translated;
  }

  /**
   * Seed derived bounds from the decode pass (item 5): install `bounds`
   * for `record` without scanning samples. The ref pins the entry exactly
   * like a miss computation, so later mutations invalidate normally.
   * Derived-only — never canonical file content.
   */
  seed(record: SurfaceObjectRecord, bounds: Bounds | null): void {
    this.boundsById.set(record.id, {
      ref: record as object,
      bounds: bounds === null ? null : { ...bounds },
    });
    this.stats.boundsSeeded += 1;
  }

  /**
   * Cached bounds for `record` (O(1) hit when the same record object is
   * unchanged since caching). Misses compute via `compute` (cheap raw
   * scan) exactly once and cache by id+ref.
   */
  cachedBounds(
    record: SurfaceObjectRecord,
    compute: (record: SurfaceObjectRecord) => Bounds | null,
  ): Bounds | null {
    const entry = this.boundsById.get(record.id);
    if (entry !== undefined && entry.ref === (record as object)) {
      this.stats.boundsHits += 1;
      return entry.bounds === null ? null : { ...entry.bounds };
    }
    this.stats.boundsMisses += 1;
    this.stats.boundsScans += 1;
    const bounds = compute(record);
    this.boundsById.set(record.id, {
      ref: record as object,
      bounds: bounds === null ? null : { ...bounds },
    });
    return bounds;
  }

  /** Direct cheap Ink bounds with store caching (no allocation on hit). */
  inkBounds(record: SurfaceObjectRecord): Bounds | null {
    return this.cachedBounds(record, cheapInkBounds);
  }

  noteCompiledHit(): void {
    this.stats.compiledHits += 1;
  }

  noteCompiledMiss(): void {
    this.stats.compiledMisses += 1;
  }
}
