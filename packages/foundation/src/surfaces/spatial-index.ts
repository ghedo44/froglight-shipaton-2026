/**
 * Model-local uniform spatial hash for Surface bounds (Slice 4).
 *
 * Provider-independent, dependency-free. Keys logical object ids to
 * conservative AABBs. Updated only when affected geometry changes;
 * queries return nearby candidates without scanning `model.order`.
 *
 * Cell size 512 surface units balances handwriting strokes (1–4 cells)
 * against whiteboard cards. Huge envelopes spanning >256 cells overflow
 * to an always-queried set instead of exploding the grid.
 */

import { boundsIntersect, type Bounds } from './geometry.js';

const DEFAULT_CELL_SIZE = 512;
const MAX_CELLS_PER_ENTRY = 256;

function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export interface SurfaceSpatialIndexStats {
  /** Entries currently indexed. */
  entries: number;
  /** Indexed queries served (no full model scan). */
  indexedQueries: number;
  /** Full model scans performed (must stay 0 after initial build). */
  fullScans: number;
  /**
   * Queries whose region spans more cells than the hash enumerates
   * (viewport prefetch margins over a fit-to-view page): served by
   * intersecting the cached bounds directly. Not a fallback scan of the
   * model — only already-indexed bounds are visited.
   */
  oversizedQueries: number;
}

export class SurfaceSpatialIndex {
  private readonly cellSize: number;
  private readonly cells = new Map<string, Set<string>>();
  private readonly boundsById = new Map<string, Bounds>();
  private readonly cellsById = new Map<string, string[]>();
  private readonly overflow = new Set<string>();
  private readonly stats: SurfaceSpatialIndexStats = {
    entries: 0,
    indexedQueries: 0,
    fullScans: 0,
    oversizedQueries: 0,
  };

  constructor(cellSize = DEFAULT_CELL_SIZE) {
    this.cellSize =
      Number.isFinite(cellSize) && cellSize > 0 ? cellSize : DEFAULT_CELL_SIZE;
  }

  statsSnapshot(): SurfaceSpatialIndexStats {
    return { ...this.stats, entries: this.boundsById.size };
  }

  clear(): void {
    this.cells.clear();
    this.boundsById.clear();
    this.cellsById.clear();
    this.overflow.clear();
  }

  get size(): number {
    return this.boundsById.size;
  }

  /** True when the id has a cached entry (bounded record). */
  has(id: string): boolean {
    return this.boundsById.has(id);
  }

  /** Cached bounds for one id (O(1), no sample scan). */
  getBounds(id: string): Bounds | null {
    const bounds = this.boundsById.get(id);
    return bounds === undefined ? null : { ...bounds };
  }

  insert(id: string, bounds: Bounds): void {
    this.remove(id);
    this.boundsById.set(id, { ...bounds });
    const keys = this.cellsFor(bounds);
    if (keys === null) {
      this.overflow.add(id);
      this.cellsById.set(id, []);
      return;
    }
    this.cellsById.set(id, keys);
    for (const key of keys) {
      let set = this.cells.get(key);
      if (set === undefined) {
        set = new Set();
        this.cells.set(key, set);
      }
      set.add(id);
    }
  }

  update(id: string, bounds: Bounds): void {
    this.insert(id, bounds);
  }

  remove(id: string): void {
    const oldCells = this.cellsById.get(id);
    if (oldCells !== undefined) {
      for (const key of oldCells) {
        const set = this.cells.get(key);
        if (set !== undefined) {
          set.delete(id);
          if (set.size === 0) this.cells.delete(key);
        }
      }
      this.cellsById.delete(id);
    }
    this.boundsById.delete(id);
    this.overflow.delete(id);
  }

  /**
   * Ids whose cached bounds intersect `bounds` (precise filter, not just
   * cell overlap). Never scans the full model.
   */
  query(bounds: Bounds): readonly string[] {
    this.stats.indexedQueries += 1;
    const keys = this.cellsFor(bounds);
    const out: string[] = [];
    const seen = new Set<string>();
    const consider = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const cached = this.boundsById.get(id);
      if (cached === undefined) return;
      if (boundsIntersect(cached, bounds)) out.push(id);
    };
    if (keys !== null) {
      for (const key of keys) {
        const set = this.cells.get(key);
        if (set === undefined) continue;
        for (const id of set) consider(id);
      }
    } else {
      // Oversized query region (e.g., a viewport prefetch margin over a
      // fit-to-view page): enumerating its cells is worse than the
      // already-indexed bounds, so intersect those directly. This is not
      // a model scan (no sample/bounds derivation happens here).
      this.stats.oversizedQueries += 1;
      for (const id of this.boundsById.keys()) consider(id);
    }
    for (const id of this.overflow) consider(id);
    return out;
  }

  /** Mark a full-model scan (for counters when fallback paths run). */
  noteFullScan(): void {
    this.stats.fullScans += 1;
  }

  private cellsFor(bounds: Bounds): string[] | null {
    if (
      !Number.isFinite(bounds.x) ||
      !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height)
    ) {
      return null;
    }
    const minCx = Math.floor(bounds.x / this.cellSize);
    const minCy = Math.floor(bounds.y / this.cellSize);
    const maxCx = Math.floor((bounds.x + bounds.width) / this.cellSize);
    const maxCy = Math.floor((bounds.y + bounds.height) / this.cellSize);
    const count = (maxCx - minCx + 1) * (maxCy - minCy + 1);
    if (count > MAX_CELLS_PER_ENTRY) return null;
    const keys: string[] = [];
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        keys.push(cellKey(cx, cy));
      }
    }
    return keys;
  }
}

/** Expand bounds by `margin` on every side (snap/viewport prefetch). */
export function expandBounds(bounds: Bounds, margin: number): Bounds {
  return {
    x: bounds.x - margin,
    y: bounds.y - margin,
    width: bounds.width + margin * 2,
    height: bounds.height + margin * 2,
  };
}

/** Union of bounds, null when empty. */
export function unionBounds(list: readonly Bounds[]): Bounds | null {
  let out: Bounds | null = null;
  for (const bounds of list) {
    out =
      out === null
        ? { ...bounds }
        : {
            x: Math.min(out.x, bounds.x),
            y: Math.min(out.y, bounds.y),
            width:
              Math.max(out.x + out.width, bounds.x + bounds.width) -
              Math.min(out.x, bounds.x),
            height:
              Math.max(out.y + out.height, bounds.y + bounds.height) -
              Math.min(out.y, bounds.y),
          };
  }
  return out;
}
