/**
 * Draw items: the plain-data rendering vocabulary.
 *
 * Object payloads compile to draw items; renderer backends consume only
 * this union plus a camera. Adding an object type never changes a backend.
 */

import type { Bounds, Point } from './geometry.js';
import type { InkSample } from './model.js';

interface ItemBase {
  /** Source object id for traceability, hit-mapping, and tests. */
  readonly objectId: string;
  /** Axis-aligned envelope bounds in surface space (pre-rotation). */
  readonly bounds: Bounds;
  /** Radians, positive clockwise around the envelope center. */
  readonly rotation: number;
}

export interface RectItem extends ItemBase {
  readonly cornerRadius?: number;
  readonly kind: 'rect';
  readonly shape?: 'rectangle' | 'rounded' | 'diamond' | 'triangle';
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
}

export interface EllipseItem extends ItemBase {
  readonly kind: 'ellipse';
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
}

export interface TextItem extends ItemBase {
  readonly kind: 'text';
  readonly text: string;
  /** Font size in surface units (already effective: defaults to 16). */
  readonly size: number;
  readonly color?: string;
  /**
   * Effective Surface text role for rendering: the compiler
   * normalizes absent/unknown wire roles to `"body"`, so backends branch
   * ONLY on this member and never read payloads. Absent means `"body"`
   * (legacy items). Verbatim preservation stays in the record, not here.
   */
  readonly role?: 'body' | 'heading' | 'caption' | 'label';
  /**
   * Effective Surface text alignment inside `[x, x + boxWidth]` (align-invariant
   * envelope — see `textV2EstBounds`). Absent means `"start"`.
   */
  readonly align?: 'start' | 'center' | 'end';
  /**
   * Effective Surface text wrap width in surface units (valid only). Absent
   * means unbounded (current behavior: explicit `\n` breaks only).
   */
  readonly wrapWidth?: number;
  /**
   * Effective additive bold trait: true when the record
   * `appearance.bold` is exactly `true`. Absent/false means inactive.
   * Backends render bold when `bold` or `role === 'heading'`.
   */
  readonly bold?: boolean;
  /**
   * Effective additive italic trait: true when the record
   * `appearance.italic` is exactly `true`. Absent/false means inactive.
   */
  readonly italic?: boolean;
}

/**
 * Image reference item. Backends that cannot resolve vault assets draw a
 * placeholder box; bitmap resolution belongs to provider wiring above the
 * seam, never to canonical data.
 */
export interface ImageRefItem extends ItemBase {
  readonly kind: 'image';
  readonly src: string;
}

/**
 * Vector ink stroke item: the authoritative modern handwriting path. The
 * compiler owns geometry (`outline`, derived from the continuous fitted
 * centerline); backends fill it in one path and never reconstruct strokes
 * from `points`. `points` carries the canonical semantic samples for
 * traceability; `outline` is always present on compiled items.
 *
 * Live preview items carry `liveMesh` INSTEAD of a materialized ring
 * (`outline` stays an empty array there): the incremental compiler
 * publishes retained mesh sides plus a bounded mutable tail, and the
 * backend traces them directly, so pointer handling never copies the
 * full stroke history per batch. Plain data only — no canvas/Path2D
 * handles cross this seam; backend-owned caches key on
 * (`objectId`, `liveMesh.version`).
 */
export interface StrokeItem extends ItemBase {
  readonly kind: 'stroke';
  /** Disconnected retained contours, filled together with nonzero winding. */
  readonly contours?: readonly (readonly Point[])[];
  readonly points: readonly InkSample[];
  /** Base width in surface units (before pressure scaling). */
  readonly width: number;
  readonly color?: string;
  readonly opacity?: number;
  /**
   * Compiled fill outline: closed ring the renderer fills in one path.
   * Always present on items produced by the stroke object type. Live
   * preview items carry `liveMesh` instead and leave this empty — a
   * complete polygon is materialized only for explicit
   * diagnostics/tests/commit APIs. Derived, never canonical.
   */
  readonly outline: readonly Point[];
  /** Incremental live mesh chunks (live preview path only). */
  readonly liveMesh?: LiveStrokeMeshView;
  /**
   * Prediction head-only clip (ephemeral predicted-tail replacement path
   * only): when present with `liveMesh`, the backend draws only the
   * prefix spine [0, liveHeadUpTo) with a butt seam (no tail, no end
   * cap) — the old mutable tail at/after this index is suppressed
   * (replaced by the predicted `replacementTail`, never repainted), so
   * translucent tools cannot double-paint history. Bounded work: frozen
   * prefix replays the cached head natively, only the bounded
   * [frozenSpine, liveHeadUpTo) prefix is retraced in JS.
   */
  readonly liveHeadUpTo?: number;
}

/**
 * Provider-neutral live-stroke mesh chunks published per pointer batch.
 * The arrays are retained live views into the incremental compiler, NOT
 * copies — entry stability is governed by `epoch`/`frozenSpine`:
 *
 * - indices below `frozenSpine` in `left`/`right` (and fans with keys
 *   below it, plus both caps) are stable while `epoch` is constant;
 * - indices at/after `frozenSpine` are the mutable tail and may be
 *   rewritten by the next append;
 * - any rewrite below `frozenSpine` (corner finalization inside the
 *   refresh horizon, settled start-zone width refresh) bumps `epoch`,
 *   and backends must drop cached head geometry for the stroke.
 *
 * Backends read these synchronously at paint time (the publishing append
 * and its paint run to completion with no interleaving mutation) and
 * must never retain the arrays beyond the paint — cache derived
 * geometry (e.g. Path2D) keyed by (`objectId`, `version`), never the
 * views themselves. `version` bumps per append that recomputes geometry;
 * duplicate-only appends reuse the version so paints replay caches.
 */
export interface LiveStrokeMeshView {
  /** Publish version (bumps per geometry-recomputing append). */
  readonly version: number;
  /** Stability epoch (bumps when frozen head entries are rewritten). */
  readonly epoch: number;
  /** Count of leading stable spine nodes (head/tail boundary). */
  readonly frozenSpine: number;
  /** Total spine nodes behind the mesh. */
  readonly spineLength: number;
  /** Retained left offset run in spine order (P + N·half). */
  readonly left: readonly Point[];
  /** Retained right offset run in spine order (P − N·half). */
  readonly right: readonly Point[];
  /** Retained round-join fans per spine index (outer side only). */
  readonly leftFans: ReadonlyMap<number, readonly Point[]>;
  /** Retained round-join fans per spine index (outer side only). */
  readonly rightFans: ReadonlyMap<number, readonly Point[]>;
  /** Retained round start-cap fan (stable after the stroke starts). */
  readonly startCap: readonly Point[];
  /** Retained round end-cap fan (moves with the tip; O(1) points). */
  readonly endCap: readonly Point[];
  /** Brush tip cap driving the mesh (butt caps omit both fans). */
  readonly cap: 'round' | 'butt';
}

/**
 * Materialize a closed outline ring from a live mesh view (explicit
 * snapshot/testing/backend-fallback API — never the per-batch live
 * path). Counts as a full-ring materialization by construction.
 */
export function materializeLiveMeshRing(view: LiveStrokeMeshView): Point[] {
  const leftRun: Point[] = [];
  for (let i = 0; i < view.left.length; i++) {
    leftRun.push({ ...view.left[i]! });
    const fan = view.leftFans.get(i);
    if (fan !== undefined) {
      for (const p of fan) leftRun.push({ ...p });
    }
  }
  const rightRun: Point[] = [];
  for (let i = 0; i < view.right.length; i++) {
    rightRun.push({ ...view.right[i]! });
    const fan = view.rightFans.get(i);
    if (fan !== undefined) {
      for (const p of fan) rightRun.push({ ...p });
    }
  }
  rightRun.reverse();
  if (view.cap === 'butt') return [...leftRun, ...rightRun];
  return [
    ...leftRun,
    ...view.endCap.map((p) => ({ ...p })),
    ...rightRun,
    ...view.startCap.map((p) => ({ ...p })),
  ];
}

/**
 * Explicit guide-polyline item for non-handwriting previews (lasso
 * marquees, circle-conversion rings, box marquees). Backends stroke it
 * directly with round caps/joins. Canonical ink never uses this kind —
 * it exists so handwriting rendering keeps exactly one authoritative
 * path instead of overloading stroke items with a legacy fallback.
 */
export interface PolylineItem extends ItemBase {
  readonly kind: 'polyline';
  readonly points: readonly Point[];
  readonly width: number;
  readonly color?: string;
  readonly opacity?: number;
}

/** Straight connector segment with optional arrowheads. */
export interface LineItem extends ItemBase {
  readonly kind: 'line';
  readonly x: number;
  readonly y: number;
  readonly x2: number;
  readonly y2: number;
  readonly width: number;
  readonly color?: string;
  readonly opacity?: number;
  readonly arrows?: 'start' | 'end' | 'both';
  /**
   * Connector routing (slice 9): absent means straight. Routed paths
   * carry their computed polyline in `points`.
   */
  readonly path?: 'straight' | 'orthogonal' | 'curved';
  readonly points?: readonly Point[];
}

/** Framed card container (whiteboard).*/
export interface CardItem extends ItemBase {
  readonly kind: 'card';
  readonly text: string;
  readonly size: number;
  readonly color?: string;
  readonly fill?: string;
  readonly stroke?: string;
}

/** Spatial resource embed placeholder/preview frame. */
export interface ResourceEmbedItem extends ItemBase {
  readonly kind: 'resource-embed';
  readonly target: {
    documentId: string;
    kindId: string;
    resourceId: string;
    address?: string;
  };
  readonly cachedTitle?: string;
}

/** Render-side analogue of the opaque wrapper: dashed bounding box. */
export interface PlaceholderItem extends ItemBase {
  readonly kind: 'placeholder';
  readonly label: string;
}

/**
 * Packed committed Ink stroke (closure-pass packed rendering).
 *
 * Cold Worker output and durable cache hits stay in typed-array form
 * through committed rendering — no `unpackCompiledInk` into thousands of
 * `SerializedInkNode`/`Point` objects for normal painting. The packed
 * payload is already compiler output (outline ring, bounds, dots baked);
 * the backend fills `polygonXY` directly. Live editing may still use the
 * rich `StrokeItem` where required; operations needing rich form lazily
 * materialize ONLY the affected item.
 *
 * Representation seam: `InkRenderableGeometry = StrokeItem | PackedStrokeItem`.
 * The shared renderer understands both without visual divergence (bit-exact
 * Float64 polygon, same fill/opacity/transform/rotation/highlighter/dot
 * semantics — dots are baked into the outline ring).
 */
export interface PackedStrokeItem extends ItemBase {
  readonly kind: 'packed-stroke';
  /** Offset from retained packed coordinates to the item's canonical coordinates. */
  readonly sourceOffset?: Point;
  /** Erasure projection; source packed geometry remains reusable. */
  readonly contours?: readonly (readonly Point[])[];
  /** Packed compiler output (cache-owned: never transfer/detach). */
  readonly packed: import('./ink/packed-protocol.js').PackedCompiledInk;
  readonly color?: string;
  readonly opacity?: number;
}

export type DrawItem =
  | RectItem
  | EllipseItem
  | TextItem
  | ImageRefItem
  | StrokeItem
  | PackedStrokeItem
  | PolylineItem
  | LineItem
  | CardItem
  | ResourceEmbedItem
  | PlaceholderItem;

/**
 * Rigid derived translation for one prepared item (scalability final
 * pass): compiled geometry stays IMMUTABLE in local geometry
 * coordinates; a pure translation only mutates this small metadata
 * record (`prepared.transform.tx += dx`), never maps/copies
 * nodes/polygon/mesh/outline/point arrays and never rebuilds the
 * B-spline. Backends apply the translation through Canvas transform
 * state (`save` → `translate(tx, ty)` → draw immutable geometry →
 * `restore`).
 *
 * The transform is intentionally mutable (`tx`/`ty` are writable) while
 * `item` is an immutable snapshot: translation is O(moved logical
 * objects), independent of sample/vertex counts. Rotation/scale are NOT
 * representable here — those are geometry mutations that recompile.
 */
export interface PreparedTransform {
  tx: number;
  ty: number;
}

/**
 * One prepared scene entry: immutable compiled geometry plus its derived
 * rigid translation. World position = local geometry + transform.
 * `transform` starts at (0, 0) when the item is (re)built from current
 * canonical samples and accumulates pure-translation deltas until the
 * next recompile/invalidation resets it.
 */
export interface PreparedItem {
  readonly item: DrawItem;
  readonly transform: PreparedTransform;
}

/** Zero-transform wrapper for freshly compiled immutable geometry. */
export function preparedItem(item: DrawItem): PreparedItem {
  return { item, transform: { tx: 0, ty: 0 } };
}

/** Zero-transform wrappers for a freshly compiled item list. */
export function preparedItems(items: readonly DrawItem[]): PreparedItem[] {
  return items.map(preparedItem);
}

/** True when the prepared entry carries no derived translation. */
export function isUntranslated(prepared: PreparedItem): boolean {
  return prepared.transform.tx === 0 && prepared.transform.ty === 0;
}
