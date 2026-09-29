/**
 * Production Canvas 2D renderer backend.
 *
 * A thin, replaceable adapter: it consumes only draw items plus the
 * camera through the shared compile/cull pipeline. No payload parsing,
 * no canonical serialization, no persistence — swapping this file for
 * another backend must not touch model, codec, or session code.
 *
 * Protocol: `begin` saves the context and installs a surface-space
 * transform (surface units become device pixels via the camera zoom), so
 * every item draws in surface coordinates; bounded frames clip once;
 * `end` restores.
 */

import type {
  Bounds,
  Camera,
  DrawItem,
  LiveStrokeMeshView,
  Point,
  PreparedTransform,
  RenderViewport,
  StrokeItem,
  SurfaceRendererBackend,
} from '@froglight/foundation';
import {
  TEXT_LINE_HEIGHT_FACTOR,
  effectiveTextSizeOf,
  packedRenderCounters,
  textAlignOf,
  textRoleOf,
  textV2Lines,
  textWrapWidthOf,
} from '@froglight/foundation';

/** Provider-level visual defaults (product styling is a later phase). */
export const CANVAS_SURFACE_DEFAULTS = {
  shapeFill: '#9aa0a6',
  textFill: '#202124',
  fontFamily: 'sans-serif',
  dashPattern: [4, 3] as const,
  referenceStroke: '#80868b',
  inkStroke: '#3c4043',
} as const;

/** Display layout uses the configured font; canonical geometry stays headless. */
function canvasTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  size: number,
  width: number | null,
): string[] {
  return textV2Lines(
    text,
    size,
    width,
    typeof ctx.measureText === 'function'
      ? (line) => ctx.measureText(line).width
      : undefined,
  );
}

/** Rounded polygon path shared by rectangles, triangles and diamonds. */
function traceRoundedPolygon(
  ctx: CanvasRenderingContext2D,
  points: readonly Point[],
  radius: number,
): void {
  const corners = points.map((point, index) => {
    const previous = points[(index + points.length - 1) % points.length]!;
    const next = points[(index + 1) % points.length]!;
    const before = Math.hypot(previous.x - point.x, previous.y - point.y);
    const after = Math.hypot(next.x - point.x, next.y - point.y);
    const cut = Math.max(0, Math.min(radius, before / 2, after / 2));
    return {
      point,
      start: {
        x: point.x + ((previous.x - point.x) * cut) / (before || 1),
        y: point.y + ((previous.y - point.y) * cut) / (before || 1),
      },
      end: {
        x: point.x + ((next.x - point.x) * cut) / (after || 1),
        y: point.y + ((next.y - point.y) * cut) / (after || 1),
      },
    };
  });
  ctx.beginPath();
  corners.forEach(({ point, start, end }, index) => {
    if (index === 0) ctx.moveTo(start.x, start.y);
    else ctx.lineTo(start.x, start.y);
    if (radius > 0 && typeof ctx.quadraticCurveTo === 'function')
      ctx.quadraticCurveTo(point.x, point.y, end.x, end.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
}

/** Backend paint counters for the live-stroke structural gate (diagnostics). */
export interface CanvasBackendPaintStats {
  /** Live-chunk Path2D (re)builds (one per published version, first paint). */
  liveRebuilds: number;
  /** Live-chunk cache replays (same-version repaints: pans, multi-paints). */
  liveReplays: number;
  /** Live-chunk direct traces (no Path2D available: headless/tests). */
  liveDirectTraces: number;
  /** Legacy outline-ring fills (committed strokes, dots, fallback). */
  outlineDraws: number;
  /** Packed-typed-array fills (committed cached/Worker strokes, no object graph). */
  packedDraws: number;
  /** Packed vertices traced from Float64Array (no Point allocation). */
  packedVerticesTraced: number;
  /**
   * Deterministic JS vertices traced for live paths (head + tail).
   * Head replays via native `addPath` trace zero here — only JS-side
   * `moveTo`/`lineTo` work counts, so long-stroke frames stay bounded.
   */
  liveVerticesTraced: number;
  /**
   * Full-history live path rebuilds (entire spine retraced in JS).
   * The incremental path must keep this at ≤1 per gesture (initial
   * build); normal frames rebuild only the mutable tail.
   */
  fullLivePathRebuilds: number;
  /** Frozen-head prefix rebuilds (epoch bump or frozenSpine growth). */
  frozenHeadRebuilds: number;
  /** Mutable-tail rebuilds (one per published version, bounded work). */
  mutableTailRebuilds: number;
  /**
   * Draws applied with a nonzero derived rigid translation (immutable
   * geometry painted through save/translate/restore). Structural proof
   * that translation commits repaint via transforms, not geometry copies.
   */
  translatedDraws: number;
  /** Repeated committed vector outlines replayed from the bounded Path2D cache. */
  committedPathReplays: number;
  /** Committed vector outlines traced into a Path2D cache entry. */
  committedPathBuilds: number;
}

/** Minimal path sink shared by Path2D and immediate-mode tracing. */
interface LivePathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
}

/**
 * Trace one spine range in compiler ring order. Fans belong to the span
 * after their vertex, so the head excludes seam fans and the tail owns
 * them. The right run reverses both the fan order and its vertex order.
 * All ranges are filled together once, including translucent overlap.
 */
function traceLiveRange(
  sink: LivePathSink,
  mesh: LiveStrokeMeshView,
  from: number,
  to: number,
): number {
  if (to <= from || mesh.left.length === 0) return 0;
  const first = mesh.left[from]!;
  if (!Number.isFinite(first.x) || !Number.isFinite(first.y)) return 0;
  sink.moveTo(first.x, first.y);
  let traced = 1;
  const line = (point: Point): void => {
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
      sink.lineTo(point.x, point.y);
      traced++;
    }
  };
  for (let i = from; i < to; i++) {
    if (i > from) line(mesh.left[i]!);
    if (i + 1 < to) {
      const fan = mesh.leftFans.get(i);
      if (fan !== undefined) for (const point of fan) line(point);
    }
  }
  if (to === mesh.left.length && mesh.cap !== 'butt') {
    for (const point of mesh.endCap) line(point);
  }
  for (let i = to - 1; i >= from; i--) {
    if (i + 1 < to) {
      const fan = mesh.rightFans.get(i);
      if (fan !== undefined) {
        for (let j = fan.length - 1; j >= 0; j--) line(fan[j]!);
      }
    }
    line(mesh.right[i]!);
  }
  if (from === 0 && mesh.cap !== 'butt') {
    for (const point of mesh.startCap) line(point);
  }
  sink.closePath();
  return traced;
}

function traceLiveMesh(sink: LivePathSink, mesh: LiveStrokeMeshView): number {
  return traceLiveRange(sink, mesh, 0, mesh.left.length);
}

function traceLiveHead(
  sink: LivePathSink,
  mesh: LiveStrokeMeshView,
  frozenSpine: number,
): number {
  return traceLiveRange(sink, mesh, 0, Math.min(frozenSpine, mesh.left.length));
}

function traceLiveTail(
  sink: LivePathSink,
  mesh: LiveStrokeMeshView,
  frozenSpine: number,
): number {
  if (frozenSpine >= mesh.left.length) return 0;
  return traceLiveRange(
    sink,
    mesh,
    Math.max(0, frozenSpine - 1),
    mesh.left.length,
  );
}

function rotationOf(item: DrawItem): number {
  return Number.isFinite(item.rotation) ? item.rotation : 0;
}

/**
 * Optional provider-supplied bitmap resolution for image draw items.
 * Keys are vault-relative asset paths; `undefined` means
 * "still loading" (placeholder), `null` means "unresolvable"
 * (placeholder), a decoded source draws in place.
 */
export type SurfaceImageResolver = ReadonlyMap<
  string,
  CanvasImageSource | null | undefined
>;

export class CanvasSurfaceRendererBackend implements SurfaceRendererBackend {
  readonly #ctx: CanvasRenderingContext2D;
  readonly #fontFamily: string;
  readonly #images?: SurfaceImageResolver;
  /**
   * Backend-owned live-stroke path cache: version-keyed Path2D per active
   * stroke id (never canonical samples, never renderer-owned samples —
   * derived geometry only, evicted when the stroke commits). A repaint of
   * an unchanged publish replays the path instead of re-tracing history.
   *
   * Incremental structure (repair item 4): the frozen head is cached
   * separately by (epoch, frozenSpine) and replayed natively via
   * `addPath` — normal frames trace only the bounded mutable tail in JS.
   * The combined path is filled ONCE, so translucent Highlighter head +
   * tail never double-paints the seam (single fill paints the union once,
   * even where head and tail share the seam edge).
   */
  readonly #livePaths = new Map<string, { version: number; path: Path2D }>();
  readonly #liveHeads = new Map<
    string,
    { epoch: number; frozenSpine: number; path: Path2D }
  >();
  /**
   * Camera changes repaint the committed cache canvas. Retain only a small
   * LRU of immutable compiled outlines so those repaints do not retrace large
   * packed polygons (or allocate filtered rich-outline arrays) every frame.
   * Packed geometry is cache-owned and replaced when recompiled; translation
   * remains a separate sourceOffset and invalidates the path entry.
   */
  readonly #committedPaths = new Map<
    string,
    {
      geometry: object;
      offsetX: number;
      offsetY: number;
      weight: number;
      path: Path2D;
    }
  >();
  #committedPathVertices = 0;
  /** Per-backend cap keeps retained Path2D data near 4 MiB of source coordinates. */
  readonly #committedPathVertexBudget = 262_144;
  readonly #paintStats: CanvasBackendPaintStats = {
    liveRebuilds: 0,
    liveReplays: 0,
    liveDirectTraces: 0,
    outlineDraws: 0,
    packedDraws: 0,
    packedVerticesTraced: 0,
    liveVerticesTraced: 0,
    fullLivePathRebuilds: 0,
    frozenHeadRebuilds: 0,
    mutableTailRebuilds: 0,
    translatedDraws: 0,
    committedPathReplays: 0,
    committedPathBuilds: 0,
  };

  constructor(
    ctx: CanvasRenderingContext2D,
    options: { images?: SurfaceImageResolver; fontFamily?: string } = {},
  ) {
    this.#ctx = ctx;
    this.#fontFamily = options.fontFamily ?? CANVAS_SURFACE_DEFAULTS.fontFamily;
    this.#images = options.images;
  }

  /** Paint counters for the live-stroke structural gate (diagnostics). */
  paintStats(): CanvasBackendPaintStats {
    return { ...this.#paintStats };
  }

  /** Reset paint counters (tests/benchmarks). */
  resetPaintStats(): void {
    this.#paintStats.liveRebuilds = 0;
    this.#paintStats.liveReplays = 0;
    this.#paintStats.liveDirectTraces = 0;
    this.#paintStats.outlineDraws = 0;
    this.#paintStats.packedDraws = 0;
    this.#paintStats.packedVerticesTraced = 0;
    this.#paintStats.liveVerticesTraced = 0;
    this.#paintStats.fullLivePathRebuilds = 0;
    this.#paintStats.frozenHeadRebuilds = 0;
    this.#paintStats.mutableTailRebuilds = 0;
    this.#paintStats.translatedDraws = 0;
    this.#paintStats.committedPathReplays = 0;
    this.#paintStats.committedPathBuilds = 0;
  }

  #committedPath(
    key: string,
    geometry: object,
    offsetX: number,
    offsetY: number,
    vertexCount: number,
    trace: (sink: LivePathSink) => void,
  ): Path2D | null {
    if (typeof Path2D !== 'function') return null;
    const cached = this.#committedPaths.get(key);
    if (
      cached !== undefined &&
      cached.geometry === geometry &&
      cached.offsetX === offsetX &&
      cached.offsetY === offsetY
    ) {
      // Map insertion order doubles as the small LRU: refresh on use.
      this.#committedPaths.delete(key);
      this.#committedPaths.set(key, cached);
      this.#paintStats.committedPathReplays += 1;
      return cached.path;
    }
    if (vertexCount < 3) {
      if (cached !== undefined) {
        this.#committedPathVertices -= cached.weight;
        this.#committedPaths.delete(key);
      }
      return null;
    }
    // Avoid both native allocation and a full Path2D trace for a path that
    // cannot fit in the retained-geometry budget. The caller uses its direct
    // Canvas path fallback for this uncommon case.
    if (vertexCount > this.#committedPathVertexBudget) {
      if (cached !== undefined) {
        this.#committedPathVertices -= cached.weight;
        this.#committedPaths.delete(key);
      }
      return null;
    }
    const path = new Path2D() as Path2D & LivePathSink;
    trace(path);
    // Tiny paths still consume native bookkeeping. Charge every cache entry
    // at least 64 vertices so adversarial collections of dots stay bounded.
    const weight = Math.max(vertexCount, 64);
    const replaced = this.#committedPaths.get(key);
    if (replaced !== undefined) {
      this.#committedPathVertices -= replaced.weight;
      this.#committedPaths.delete(key);
    }
    // Evict least-recently-used entries until the geometry budget fits.
    while (
      this.#committedPathVertices + weight >
      this.#committedPathVertexBudget
    ) {
      const oldest = this.#committedPaths.keys().next();
      if (oldest.done === true) break;
      const removed = this.#committedPaths.get(oldest.value);
      if (removed !== undefined) {
        this.#committedPathVertices -= removed.weight;
        this.#committedPaths.delete(oldest.value);
      }
    }
    this.#committedPaths.set(key, {
      geometry,
      offsetX,
      offsetY,
      weight,
      path,
    });
    this.#committedPathVertices += weight;
    this.#paintStats.committedPathBuilds += 1;
    return path;
  }

  begin(camera: Camera, viewport: RenderViewport): void {
    const ctx = this.#ctx;
    const dpr = viewport.dpr ?? 1;
    ctx.save();
    // Installs the surface-space transform ONLY. Clearing is explicit
    // (see clear) so compositors can layer content without a begin call
    // wiping what they already painted.
    ctx.setTransform(
      dpr * camera.zoom,
      0,
      0,
      dpr * camera.zoom,
      -camera.x * camera.zoom * dpr,
      -camera.y * camera.zoom * dpr,
    );
  }

  /** Full-device clear in device pixels; safe between frames. */
  clear(viewport: RenderViewport): void {
    const ctx = this.#ctx;
    const dpr = viewport.dpr ?? 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, viewport.width * dpr, viewport.height * dpr);
    ctx.restore();
  }

  clipToFrame(frame: Bounds): void {
    const ctx = this.#ctx;
    ctx.beginPath();
    ctx.rect(frame.x, frame.y, frame.width, frame.height);
    ctx.clip();
  }

  /**
   * Fill one live preview stroke from its mesh chunks. Incremental
   * structure: cached immutable/frozen head + small mutable tail.
   *
   * With Path2D available the frozen head is cached by (epoch,
   * frozenSpine) and replayed natively via `addPath` (zero JS vertex
   * work); only the bounded mutable tail is retraced in JS per published
   * version. The combined path is filled ONCE — head and tail share
   * exactly the seam edge, and a single fill paints their union once, so
   * translucent Highlighter never darkens the seam. Without Path2D
   * (headless/tests) the chunks trace directly every paint — same pixels,
   * counted as a full rebuild.
   */
  #fillLiveMesh(
    objectId: string,
    item: StrokeItem,
    mesh: LiveStrokeMeshView,
  ): void {
    const ctx = this.#ctx;
    ctx.fillStyle = item.color ?? CANVAS_SURFACE_DEFAULTS.inkStroke;
    // Translucent tools must not double-paint: single fill per paint.
    const alpha = typeof item.opacity === 'number' ? item.opacity : 1;
    const prevAlpha = (ctx as { globalAlpha?: number }).globalAlpha;
    if (alpha !== 1) ctx.globalAlpha = alpha;
    try {
      this.#fillLiveMeshInner(objectId, mesh);
    } finally {
      if (alpha !== 1) ctx.globalAlpha = prevAlpha ?? 1;
    }
  }

  #fillLiveMeshInner(objectId: string, mesh: LiveStrokeMeshView): void {
    const ctx = this.#ctx;
    const Path2DCtor =
      typeof Path2D === 'function'
        ? (Path2D as unknown as new () => Path2D & {
            addPath?: (path: Path2D) => void;
          })
        : null;
    if (Path2DCtor !== null) {
      const cached = this.#livePaths.get(objectId);
      if (cached !== undefined && cached.version === mesh.version) {
        ctx.fill(cached.path as unknown as Path2D);
        this.#paintStats.liveReplays += 1;
        return;
      }
      const frozenSpine = Math.max(
        0,
        Math.min(mesh.frozenSpine, mesh.left.length),
      );
      const combined = new Path2DCtor() as unknown as Path2D & {
        addPath?: (path: Path2D) => void;
      };
      const hasAddPath = typeof combined.addPath === 'function';
      // Without native addPath (test fakes) the head cache cannot replay
      // natively — fall back to a single full trace (one Path2D, same
      // pixels, counted as a full rebuild). This keeps the StubPath test
      // at one path per rebuild and headless correctness intact.
      if (!hasAddPath) {
        const full = traceLiveMesh(combined as unknown as LivePathSink, mesh);
        this.#paintStats.liveVerticesTraced += full;
        this.#paintStats.fullLivePathRebuilds += 1;
        this.#paintStats.mutableTailRebuilds += 1;
        this.#paintStats.liveRebuilds += 1;
        this.#livePaths.set(objectId, {
          version: mesh.version,
          path: combined as unknown as Path2D,
        });
        while (this.#livePaths.size > 8) {
          const oldest = this.#livePaths.keys().next();
          if (oldest.done === true) break;
          this.#livePaths.delete(oldest.value);
        }
        ctx.fill(combined as unknown as Path2D);
        return;
      }
      const headCached = this.#liveHeads.get(objectId);
      let headPath: Path2D | null = null;
      let headVertices = 0;
      // Stale-head tolerance (spine nodes): the frozen head grows a few
      // nodes per batch; rebuilding it from scratch every frame would be
      // O(n) per frame (O(n²) cumulative). Reuse a stale head cached at
      // oldFrozen <= frozenSpine while the gap stays bounded — the tail
      // starts at the cached boundary (covering the gap + mutable tail,
      // still bounded) — and rebuild only when the gap exceeds tolerance
      // or the epoch bumps (frozen rewrite, rare). This keeps normal
      // frames O(tail) with occasional intentional head updates.
      const HEAD_STALE_TOLERANCE = 256;
      let effectiveFrozen = frozenSpine;
      if (
        headCached !== undefined &&
        headCached.epoch === mesh.epoch &&
        headCached.frozenSpine <= frozenSpine &&
        frozenSpine - headCached.frozenSpine <= HEAD_STALE_TOLERANCE &&
        frozenSpine > 0
      ) {
        headPath = headCached.path;
        effectiveFrozen = headCached.frozenSpine;
      } else if (frozenSpine > 0) {
        const built = new Path2DCtor() as unknown as Path2D & LivePathSink;
        headVertices = traceLiveHead(
          built as unknown as LivePathSink,
          mesh,
          frozenSpine,
        );
        headPath = built as unknown as Path2D;
        this.#liveHeads.set(objectId, {
          epoch: mesh.epoch,
          frozenSpine,
          path: headPath,
        });
        this.#paintStats.frozenHeadRebuilds += 1;
        while (this.#liveHeads.size > 8) {
          const oldest = this.#liveHeads.keys().next();
          if (oldest.done === true) break;
          this.#liveHeads.delete(oldest.value);
        }
      } else {
        // No frozen head (stroke start): drop any stale head cache.
        if (headCached !== undefined) this.#liveHeads.delete(objectId);
      }
      let tailVertices = 0;
      if (headPath !== null) {
        (combined as unknown as { addPath: (p: Path2D) => void }).addPath(
          headPath,
        );
        const tailSink = combined as unknown as LivePathSink;
        tailVertices = traceLiveTail(tailSink, mesh, effectiveFrozen);
      } else {
        tailVertices = traceLiveTail(
          combined as unknown as LivePathSink,
          mesh,
          frozenSpine,
        );
        // No head: tail trace is the full stroke (initial build).
        if (frozenSpine <= 0) {
          this.#paintStats.fullLivePathRebuilds += 1;
        }
      }
      this.#paintStats.liveVerticesTraced += headVertices + tailVertices;
      this.#paintStats.mutableTailRebuilds += 1;
      this.#paintStats.liveRebuilds += 1;
      this.#livePaths.set(objectId, {
        version: mesh.version,
        path: combined as unknown as Path2D,
      });
      while (this.#livePaths.size > 8) {
        const oldest = this.#livePaths.keys().next();
        if (oldest.done === true) break;
        this.#livePaths.delete(oldest.value);
      }
      ctx.fill(combined as unknown as Path2D);
      return;
    }
    ctx.beginPath();
    const traced = traceLiveMesh(ctx, mesh);
    ctx.fill();
    this.#paintStats.liveDirectTraces += 1;
    this.#paintStats.liveVerticesTraced += traced;
    this.#paintStats.fullLivePathRebuilds += 1;
  }

  /**
   * Fill only the stable head prefix [0, upTo) with a butt seam (no tail,
   * no end cap) for the prediction-replacement path. Frozen prefix
   * [0, frozenSpine) replays the cached head natively (zero JS work);
   * only the bounded [frozenSpine, upTo) prefix is retraced in JS.
   * Single fill, no overlapping area with the replacement tail item —
   * Highlighter-safe (no overlap-darkening, seam shares exactly one
   * cross-section edge).
   */
  #fillLiveHeadOnly(
    objectId: string,
    item: StrokeItem,
    mesh: LiveStrokeMeshView,
    upTo: number,
  ): void {
    const ctx = this.#ctx;
    ctx.fillStyle = item.color ?? CANVAS_SURFACE_DEFAULTS.inkStroke;
    const Path2DCtor =
      typeof Path2D === 'function'
        ? (Path2D as unknown as new () => Path2D & {
            addPath?: (path: Path2D) => void;
          })
        : null;
    if (Path2DCtor === null) {
      // Headless fallback: trace prefix directly (bounded for predictions
      // since upTo is in the mutable tail; tiny strokes trace fully but
      // stay bounded by their size).
      ctx.beginPath();
      const clamped = Math.max(0, Math.min(upTo, mesh.left.length));
      const traced = traceLiveHead(ctx, mesh, clamped);
      ctx.fill();
      this.#paintStats.liveDirectTraces += 1;
      this.#paintStats.liveVerticesTraced += traced;
      return;
    }
    const frozenSpine = Math.max(
      0,
      Math.min(mesh.frozenSpine, mesh.left.length),
    );
    const clampedUpTo = Math.max(0, Math.min(upTo, mesh.left.length));
    // Head cache for the frozen prefix (native replay, zero JS).
    const headCached = this.#liveHeads.get(objectId);
    let frozenPath: Path2D | null = null;
    let frozenVertices = 0;
    if (frozenSpine > 0) {
      if (
        headCached !== undefined &&
        headCached.epoch === mesh.epoch &&
        headCached.frozenSpine === frozenSpine
      ) {
        frozenPath = headCached.path;
      } else {
        const built = new Path2DCtor() as unknown as Path2D & LivePathSink;
        frozenVertices = traceLiveHead(
          built as unknown as LivePathSink,
          { ...mesh, frozenSpine } as LiveStrokeMeshView,
          frozenSpine,
        );
        // traceLiveHead above includes endCap only when fully frozen;
        // for head-only prefix with upTo > frozenSpine it correctly omits
        // the tip cap (butt seam). When upTo <= frozenSpine we need a
        // shorter prefix, not the full frozen head — fall through to the
        // bounded trace below (frozen prefix small in that case).
        if (clampedUpTo >= frozenSpine) {
          frozenPath = built as unknown as Path2D;
          this.#liveHeads.set(objectId, {
            epoch: mesh.epoch,
            frozenSpine,
            path: frozenPath,
          });
          this.#paintStats.frozenHeadRebuilds += 1;
        } else {
          // Prefix inside the frozen head (tiny strokes): trace directly
          // (bounded by upTo, no cache — avoids caching every prefix).
          frozenPath = null;
          frozenVertices = 0;
        }
      }
    }
    const combined = new Path2DCtor() as unknown as Path2D & {
      addPath?: (path: Path2D) => void;
    };
    let tailVertices = 0;
    if (
      frozenPath !== null &&
      clampedUpTo >= frozenSpine &&
      typeof combined.addPath === 'function'
    ) {
      combined.addPath(frozenPath);
      // Bounded mutable prefix [frozenSpine - 1, upTo) with butt seams.
      // Shares exactly the seam cross-section edge with the head (no gap,
      // no overlapping area) and starts its own subpath with an explicit
      // moveTo — never rely on Path2D current-point state after addPath()
      // (a closed cached head leaves the current point at its start, so a
      // bare lineTo would emit a flickering origin→tip chord).
      const sink = combined as unknown as LivePathSink;
      if (clampedUpTo > frozenSpine) {
        tailVertices = traceLiveRange(sink, mesh, frozenSpine - 1, clampedUpTo);
      }
      this.#paintStats.liveVerticesTraced += frozenVertices + tailVertices;
      // Head-only draws are bounded tail work, never full rebuilds.
      this.#paintStats.mutableTailRebuilds += 1;
      ctx.fill(combined as unknown as Path2D);
      return;
    }
    // Fallback: trace prefix directly (tiny strokes or no addPath).
    const sink = combined as unknown as LivePathSink;
    tailVertices = traceLiveHead(sink, mesh, clampedUpTo);
    this.#paintStats.liveVerticesTraced += tailVertices;
    this.#paintStats.mutableTailRebuilds += 1;
    ctx.fill(combined as unknown as Path2D);
  }

  draw(item: DrawItem, transform?: PreparedTransform): void {
    const tx = transform?.tx ?? 0;
    const ty = transform?.ty ?? 0;
    // Rigid derived translation applies through Canvas transform state
    // around the immutable local-geometry draw — never by rewriting item
    // points. The outer save/restore also contains per-kind state leaks
    // (e.g. stroke globalAlpha) within this draw.
    const translated = tx !== 0 || ty !== 0;
    if (translated) {
      this.#ctx.save();
      this.#ctx.translate(tx, ty);
      this.#paintStats.translatedDraws += 1;
    }
    try {
      this.#drawInner(item);
    } finally {
      if (translated) this.#ctx.restore();
    }
  }

  #fillContours(contours: readonly (readonly Point[])[], color: string): void {
    const ctx = this.#ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const ring of contours) {
      if (ring.length < 3) continue;
      ctx.moveTo(ring[0]!.x, ring[0]!.y);
      for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i]!.x, ring[i]!.y);
      ctx.closePath();
    }
    // One nonzero fill preserves holes and translucent self-overlap.
    ctx.fill();
  }

  #drawInner(item: DrawItem): void {
    const ctx = this.#ctx;
    const rotation = rotationOf(item);

    // Rotation pivot convention: every object rotates around the center of its
    // derived envelope bounds — for text, the full wrapped multi-line
    // envelope (not just the first nominal line box) — so hit-testing
    // and rendering always agree. `(x, y)` stays the top-left of the
    // first line box (pre-rotation).
    const centerOfBounds = () => ({
      x: item.bounds.x + item.bounds.width / 2,
      y: item.bounds.y + item.bounds.height / 2,
    });

    if (item.kind === 'text') {
      // Surface text: plain-data only —
      // branches on `item.role` / `item.align` / `item.wrapWidth` /
      // `item.bold` / `item.italic`, never on payloads.
      // Unknown wire roles already compile to `"body"` (see `textRoleOf`);
      // defensively default again here so a hand-built item still renders
      // as body. Role affects weight only (heading bold), never size/box,
      // so bounds stay role-invariant; additive bold/italic traits render
      // as weight/style inside the same envelope (never inflate it).
      // Align positions lines inside `[x, x + boxWidth]` without moving
      // the envelope. Layout uses the canonical shared helpers
      // (`effectiveTextSizeOf` / `textRoleOf` / `textAlignOf` /
      // `textWrapWidthOf` / `textV2Lines` / `TEXT_LINE_HEIGHT_FACTOR`) —
      // (done) — single-sourced in
      // `packages/foundation/src/surfaces/{model,geometry}.ts` via the
      // surfaces barrel, so this backend never restates caps/defaults.
      const size = effectiveTextSizeOf(item);
      const role = textRoleOf(item);
      const align = textAlignOf({ appearance: { align: item.align } });
      const wrapWidth = textWrapWidthOf({
        appearance: { wrapWidth: item.wrapWidth },
      });
      const bold =
        (item as { readonly bold?: unknown }).bold === true ||
        role === 'heading';
      const italic = (item as { readonly italic?: unknown }).italic === true;
      const boxWidth = item.bounds.width;
      const baseX =
        align === 'center'
          ? item.bounds.x + boxWidth / 2
          : align === 'end'
            ? item.bounds.x + boxWidth
            : item.bounds.x;
      const weight = bold ? 'bold ' : '';
      const style = italic ? 'italic ' : '';
      ctx.font = `${style}${weight}${size}px ${this.#fontFamily}`;
      const laidLines = canvasTextLines(ctx, item.text, size, wrapWidth);
      ctx.fillStyle = item.color ?? CANVAS_SURFACE_DEFAULTS.textFill;
      try {
        (ctx as unknown as { textAlign?: string }).textAlign =
          align === 'center' ? 'center' : align === 'end' ? 'right' : 'left';
      } catch {
        // Headless stubs without textAlign still draw at baseX.
      }
      // Baseline convention: first baseline at (y + size), each next line
      // one nominal line-box (`TEXT_LINE_HEIGHT_FACTOR × size`) lower.
      const drawLines = (dx: number, dy: number): void => {
        for (let i = 0; i < laidLines.length; i++) {
          const baselineY =
            item.bounds.y + size + i * TEXT_LINE_HEIGHT_FACTOR * size;
          ctx.fillText(laidLines[i]!, baseX + dx, baselineY + dy);
        }
      };
      if (rotation !== 0) {
        const center = centerOfBounds();
        ctx.save();
        ctx.translate(center.x, center.y);
        ctx.rotate(rotation);
        drawLines(-center.x, -center.y);
        ctx.restore();
      } else {
        drawLines(0, 0);
      }
      try {
        (ctx as unknown as { textAlign?: string }).textAlign = 'left';
      } catch {
        // Ignore.
      }
      return;
    }

    const rotated = rotation !== 0 && item.kind !== 'ellipse';
    if (rotated) {
      const center = centerOfBounds();
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate(rotation);
      ctx.translate(-center.x, -center.y);
    }

    switch (item.kind) {
      case 'rect': {
        const radius = item.cornerRadius ?? (item.shape === 'rounded' ? 12 : 0);
        if (
          radius > 0 ||
          item.shape === 'triangle' ||
          item.shape === 'diamond'
        ) {
          const { x, y, width: w, height: h } = item.bounds;
          const points =
            item.shape === 'triangle'
              ? [
                  { x: x + w / 2, y },
                  { x: x + w, y: y + h },
                  { x, y: y + h },
                ]
              : item.shape === 'diamond'
                ? [
                    { x: x + w / 2, y },
                    { x: x + w, y: y + h / 2 },
                    { x: x + w / 2, y: y + h },
                    { x, y: y + h / 2 },
                  ]
                : [
                    { x, y },
                    { x: x + w, y },
                    { x: x + w, y: y + h },
                    { x, y: y + h },
                  ];
          traceRoundedPolygon(ctx, points, radius);
          if (item.fill !== undefined || item.stroke === undefined) {
            ctx.fillStyle = item.fill ?? CANVAS_SURFACE_DEFAULTS.shapeFill;
            ctx.fill();
          }
          if (item.stroke !== undefined) {
            ctx.strokeStyle = item.stroke;
            ctx.lineWidth = item.strokeWidth ?? 2;
            ctx.stroke();
          }
          break;
        }

        if (item.fill !== undefined || item.stroke === undefined) {
          ctx.fillStyle = item.fill ?? CANVAS_SURFACE_DEFAULTS.shapeFill;
          ctx.fillRect(
            item.bounds.x,
            item.bounds.y,
            item.bounds.width,
            item.bounds.height,
          );
        }
        if (item.stroke !== undefined) {
          ctx.strokeStyle = item.stroke;
          ctx.lineWidth = item.strokeWidth ?? 2;
          ctx.strokeRect(
            item.bounds.x,
            item.bounds.y,
            item.bounds.width,
            item.bounds.height,
          );
        }
        break;
      }
      case 'card': {
        ctx.fillStyle = item.fill ?? '#ffffff';
        ctx.fillRect(
          item.bounds.x,
          item.bounds.y,
          item.bounds.width,
          item.bounds.height,
        );
        if (item.stroke) {
          ctx.strokeStyle = item.stroke;
          ctx.strokeRect(
            item.bounds.x,
            item.bounds.y,
            item.bounds.width,
            item.bounds.height,
          );
        } else {
          ctx.strokeStyle = CANVAS_SURFACE_DEFAULTS.referenceStroke;
          ctx.strokeRect(
            item.bounds.x,
            item.bounds.y,
            item.bounds.width,
            item.bounds.height,
          );
        }
        ctx.fillStyle = item.color ?? CANVAS_SURFACE_DEFAULTS.textFill;
        ctx.font = `${item.size}px ${this.#fontFamily}`;
        ctx.save();
        ctx.beginPath();
        ctx.rect(
          item.bounds.x + 8,
          item.bounds.y + 8,
          Math.max(0, item.bounds.width - 16),
          Math.max(0, item.bounds.height - 16),
        );
        ctx.clip();
        const lines = canvasTextLines(
          ctx,
          item.text,
          item.size,
          Math.max(24, item.bounds.width - 16),
        );
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        lines.forEach((line, index) =>
          ctx.fillText(
            line,
            item.bounds.x + 8,
            item.bounds.y + 8 + item.size + index * item.size * 1.25,
          ),
        );
        ctx.restore();
        break;
      }
      case 'resource-embed': {
        ctx.setLineDash([...CANVAS_SURFACE_DEFAULTS.dashPattern]);
        ctx.strokeStyle = CANVAS_SURFACE_DEFAULTS.referenceStroke;
        ctx.strokeRect(
          item.bounds.x,
          item.bounds.y,
          item.bounds.width,
          item.bounds.height,
        );
        ctx.setLineDash([]);
        if (item.cachedTitle) {
          ctx.fillStyle = CANVAS_SURFACE_DEFAULTS.textFill;
          ctx.font = `12px ${this.#fontFamily}`;
          ctx.fillText(item.cachedTitle, item.bounds.x + 6, item.bounds.y + 14);
        }
        break;
      }
      case 'ellipse': {
        ctx.beginPath();
        ctx.ellipse(
          item.bounds.x + item.bounds.width / 2,
          item.bounds.y + item.bounds.height / 2,
          Math.max(item.bounds.width / 2, 0),
          Math.max(item.bounds.height / 2, 0),
          rotation,
          0,
          Math.PI * 2,
        );
        if (item.fill !== undefined || item.stroke === undefined) {
          ctx.fillStyle = item.fill ?? CANVAS_SURFACE_DEFAULTS.shapeFill;
          ctx.fill();
        }
        if (item.stroke !== undefined) {
          ctx.strokeStyle = item.stroke;
          ctx.lineWidth = item.strokeWidth ?? 2;
          ctx.stroke();
        }
        break;
      }
      case 'stroke': {
        // One authoritative smooth-stroke path: the compiler owns geometry
        // and the backend fills it in one path. There is no per-segment
        // fallback. Committed strokes (and dots) carry the compiled
        // outline ring; live preview strokes carry mesh chunks instead of
        // a materialized ring, traced here through a version-keyed cached
        // path — repaints of an unchanged publish replay without
        // re-tracing history, and no full-ring array is ever allocated on
        // the event path. Outline-less stroke items draw nothing.
        //
        // Prediction replacement path: `liveHeadUpTo` draws only the
        // stable head prefix [0, liveHeadUpTo) with a butt seam (old
        // mutable tail suppressed, replaced by the predicted tail item).
        // Frozen prefix replays the cached head natively; only the
        // bounded [frozenSpine, liveHeadUpTo) prefix is retraced in JS.
        // Single fill, no overlapping area — Highlighter-safe.
        const mesh = item.liveMesh;
        ctx.globalAlpha = typeof item.opacity === 'number' ? item.opacity : 1;
        if (item.contours !== undefined) {
          this.#fillContours(
            item.contours,
            item.color ?? CANVAS_SURFACE_DEFAULTS.inkStroke,
          );
        } else if (
          mesh !== undefined &&
          mesh.spineLength >= 2 &&
          mesh.left.length > 0
        ) {
          const headUpTo =
            typeof item.liveHeadUpTo === 'number'
              ? Math.max(
                  0,
                  Math.min(Math.floor(item.liveHeadUpTo), mesh.left.length),
                )
              : null;
          if (headUpTo !== null) {
            this.#fillLiveHeadOnly(item.objectId, item, mesh, headUpTo);
          } else {
            this.#fillLiveMesh(item.objectId, item, mesh);
          }
        } else {
          // This stroke no longer previews (committed, cancelled, or a
          // dot): drop any cached live path for the id.
          this.#livePaths.delete(item.objectId);
          this.#liveHeads.delete(item.objectId);
          const path =
            item.outline.length >= 3
              ? this.#committedPath(
                  `stroke:${item.objectId}`,
                  item.outline,
                  0,
                  0,
                  item.outline.length,
                  (sink) => {
                    let first: Point | undefined;
                    let count = 0;
                    for (const point of item.outline) {
                      if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
                        continue;
                      if (first === undefined) {
                        first = point;
                        sink.moveTo(point.x, point.y);
                      } else {
                        sink.lineTo(point.x, point.y);
                      }
                      count += 1;
                    }
                    if (count >= 3) sink.closePath();
                  },
                )
              : null;
          if (path !== null) {
            // A path with fewer than three finite vertices has no fill area.
            ctx.fillStyle = item.color ?? CANVAS_SURFACE_DEFAULTS.inkStroke;
            ctx.fill(path);
          } else {
            const outline = item.outline.filter(
              (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
            );
            if (outline.length >= 3) {
              ctx.fillStyle = item.color ?? CANVAS_SURFACE_DEFAULTS.inkStroke;
              ctx.beginPath();
              ctx.moveTo(outline[0]!.x, outline[0]!.y);
              for (let i = 1; i < outline.length; i++) {
                ctx.lineTo(outline[i]!.x, outline[i]!.y);
              }
              ctx.closePath();
              ctx.fill();
            }
          }
          this.#paintStats.outlineDraws += 1;
        }
        ctx.globalAlpha = 1;
        break;
      }
      case 'packed-stroke': {
        // Packed committed Ink (closure pass): cold Worker output and
        // durable cache hits stay in typed-array form — no
        // `unpackCompiledInk` into `SerializedInkNode`/`Point` object graphs
        // for normal painting. `polygonXY` is the verbatim compiler outline
        // ring (Float64 bit-exact), so this is pixel-identical to the rich
        // `stroke` fill above (same single-fill Highlighter semantics, same
        // dots baked into the ring, same opacity/transform/rotation).
        // Consumed, not re-derived: no geometry algorithm duplicated here.
        ctx.globalAlpha = typeof item.opacity === 'number' ? item.opacity : 1;
        this.#livePaths.delete(item.objectId);
        this.#liveHeads.delete(item.objectId);
        const polygon = item.packed.polygonXY;
        const offsetX = item.sourceOffset?.x ?? 0;
        const offsetY = item.sourceOffset?.y ?? 0;
        if (item.contours !== undefined) {
          this.#fillContours(
            item.contours,
            item.color ?? CANVAS_SURFACE_DEFAULTS.inkStroke,
          );
        } else if (polygon.length >= 6) {
          ctx.fillStyle = item.color ?? CANVAS_SURFACE_DEFAULTS.inkStroke;
          const path = this.#committedPath(
            `packed:${item.objectId}`,
            polygon,
            offsetX,
            offsetY,
            polygon.length / 2,
            (sink) => {
              // First vertex must be finite (validated payloads always are);
              // later invalid vertices are skipped with connect-across semantics.
              sink.moveTo(polygon[0]! + offsetX, polygon[1]! + offsetY);
              let traced = 1;
              for (let i = 2; i + 1 < polygon.length; i += 2) {
                const x = polygon[i]!;
                const y = polygon[i + 1]!;
                if (Number.isFinite(x) && Number.isFinite(y)) {
                  sink.lineTo(x + offsetX, y + offsetY);
                  traced += 1;
                }
              }
              sink.closePath();
              this.#paintStats.packedVerticesTraced += traced;
            },
          );
          if (path !== null) {
            ctx.fill(path);
          } else {
            ctx.beginPath();
            // First vertex must be finite (validated payloads always are);
            // subsequent non-finite vertices are skipped inline (same
            // connect-across semantics as the rich filter, zero allocation).
            ctx.moveTo(polygon[0]! + offsetX, polygon[1]! + offsetY);
            let traced = 1;
            for (let i = 2; i + 1 < polygon.length; i += 2) {
              const x = polygon[i]!;
              const y = polygon[i + 1]!;
              if (Number.isFinite(x) && Number.isFinite(y)) {
                ctx.lineTo(x + offsetX, y + offsetY);
                traced += 1;
              }
            }
            ctx.closePath();
            ctx.fill();
            this.#paintStats.packedVerticesTraced += traced;
          }
        }
        this.#paintStats.packedDraws += 1;
        packedRenderCounters.packedDrawItemsRendered += 1;
        ctx.globalAlpha = 1;
        break;
      }
      case 'polyline': {
        // Explicit guide-polyline kind for non-handwriting previews
        // (lasso marquees, conversion rings). The only stroked-polyline
        // path in the renderer; canonical ink never reaches it.
        const points = item.points.filter(
          (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
        );
        if (points.length === 0) break;
        ctx.globalAlpha = typeof item.opacity === 'number' ? item.opacity : 1;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = item.color ?? CANVAS_SURFACE_DEFAULTS.inkStroke;
        ctx.lineWidth = Math.max(item.width, 0);
        ctx.beginPath();
        ctx.moveTo(points[0]!.x, points[0]!.y);
        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(points[i]!.x, points[i]!.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        break;
      }
      case 'line': {
        ctx.globalAlpha = typeof item.opacity === 'number' ? item.opacity : 1;
        ctx.strokeStyle = item.color ?? CANVAS_SURFACE_DEFAULTS.inkStroke;
        ctx.lineWidth = Math.max(item.width, 0);
        ctx.lineCap = 'round';
        // Routed connectors carry their polyline; plain lines use endpoints.
        const route =
          item.points !== undefined && item.points.length >= 2
            ? item.points
            : [
                { x: item.x, y: item.y },
                { x: item.x2, y: item.y2 },
              ];
        const first = route[0]!;
        const second = route[1]!;
        const penultimate = route[route.length - 2]!;
        const last = route[route.length - 1]!;
        const angle = Math.atan2(
          last.y - penultimate.y,
          last.x - penultimate.x,
        );
        const startAngle = Math.atan2(second.y - first.y, second.x - first.x);
        // Arrowheads scale with stroke width so they stay legible at any zoom.
        const headLength =
          item.arrows === undefined ? 0 : Math.max(item.width * 3.2, 8);
        const drawHead = (
          tipX: number,
          tipY: number,
          direction: number,
        ): void => {
          if (headLength === 0) return;
          const halfSpread = Math.PI / 7;
          const wingA = direction + Math.PI - halfSpread;
          const wingB = direction + Math.PI + halfSpread;
          ctx.beginPath();
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(
            tipX + headLength * Math.cos(wingA),
            tipY + headLength * Math.sin(wingA),
          );
          ctx.lineTo(
            tipX + headLength * Math.cos(wingB),
            tipY + headLength * Math.sin(wingB),
          );
          ctx.closePath();
          ctx.fillStyle = ctx.strokeStyle;
          ctx.fill();
        };
        // Trim the end segments so they do not poke through arrowheads.
        const trim =
          item.arrows === 'both'
            ? headLength
            : item.arrows !== undefined && item.arrows === 'end'
              ? headLength * 0.6
              : 0;
        const trimStart =
          item.arrows === 'both' || item.arrows === 'start'
            ? headLength * 0.6
            : 0;
        const endLength =
          Math.hypot(last.x - penultimate.x, last.y - penultimate.y) || 1;
        const startLength =
          Math.hypot(second.x - first.x, second.y - first.y) || 1;
        const ex = last.x - ((last.x - penultimate.x) / endLength) * trim;
        const ey = last.y - ((last.y - penultimate.y) / endLength) * trim;
        const sx = first.x + ((second.x - first.x) / startLength) * trimStart;
        const sy = first.y + ((second.y - first.y) / startLength) * trimStart;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        for (let i = 1; i < route.length - 1; i++) {
          ctx.lineTo(route[i]!.x, route[i]!.y);
        }
        ctx.lineTo(ex, ey);
        ctx.stroke();
        if (item.arrows === 'end' || item.arrows === 'both') {
          drawHead(last.x, last.y, angle);
        }
        if (item.arrows === 'start' || item.arrows === 'both') {
          drawHead(first.x, first.y, startAngle + Math.PI);
        }
        ctx.globalAlpha = 1;
        break;
      }
      case 'image': {
        // Provider-supplied bitmaps draw in place; anything unresolved or
        // still loading renders as a placeholder box (never invented
        // content). Resolution belongs to integration above this seam.
        const resolved = this.#images?.get(item.src);
        if (resolved !== undefined && resolved !== null) {
          ctx.save();
          if (item.rotation !== 0) {
            const cx = item.bounds.x + item.bounds.width / 2;
            const cy = item.bounds.y + item.bounds.height / 2;
            ctx.translate(cx, cy);
            ctx.rotate(item.rotation);
            ctx.translate(-cx, -cy);
          }
          ctx.drawImage(
            resolved,
            item.bounds.x,
            item.bounds.y,
            Math.max(item.bounds.width, Number.EPSILON),
            Math.max(item.bounds.height, Number.EPSILON),
          );
          ctx.restore();
          break;
        }
        ctx.setLineDash([...CANVAS_SURFACE_DEFAULTS.dashPattern]);
        ctx.strokeStyle = CANVAS_SURFACE_DEFAULTS.shapeFill;
        ctx.strokeRect(
          item.bounds.x,
          item.bounds.y,
          item.bounds.width,
          item.bounds.height,
        );
        ctx.setLineDash([]);
        break;
      }
      case 'placeholder': {
        ctx.setLineDash([...CANVAS_SURFACE_DEFAULTS.dashPattern]);
        ctx.strokeStyle = CANVAS_SURFACE_DEFAULTS.referenceStroke;
        ctx.strokeRect(
          item.bounds.x,
          item.bounds.y,
          item.bounds.width,
          item.bounds.height,
        );
        ctx.setLineDash([]);
        break;
      }
    }

    if (rotated) {
      ctx.restore();
    }
  }

  end(): void {
    this.#ctx.restore();
  }
}
