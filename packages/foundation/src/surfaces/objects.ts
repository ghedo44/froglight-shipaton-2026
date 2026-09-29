import { inkRegion, regionBounds, mapInkRegion } from './ink/fragments.js';
/**
 * The four baseline core object types:
 * headless geometry predicates plus draw-item compilers. These are
 * ordinary registry citizens — the render pipeline has no core-type
 * special cases.
 */

import { logicalSamples, type LogicalStrokeGroup } from './logical-stroke.js';
import { hitVisible } from './ink/erasure.js';
import {
  SURFACE_OBJECT_TYPES,
  chunkIndexOf,
  effectiveSurfaceTextSizeOf,
  logicalIdOf,
  textAlignOf,
  textBoldOf,
  textItalicOf,
  textRoleOf,
  textWrapWidthOf,
  type ConnectorAnchor,
  type InkSample,
  type LineArrows,
  type SurfaceModel,
  type SurfaceObjectRecord,
} from './model.js';
import type { DrawItem } from './draw.js';
import {
  finiteNumber,
  pointInEllipse,
  pointInRotatedBounds,
  pointPolylineDistance,
  pointInPolygon,
  rotateAround,
  textV2EstBounds,
  unrotateAround,
  centerOfBounds,
  type Bounds,
  type Point,
} from './geometry.js';
import {
  InMemorySurfaceObjectTypeRegistry,
  type SurfaceObjectTypeDescriptor,
  type SurfaceObjectTypeRegistry,
} from './registry.js';
import { routeConnector } from './ink/connectors.js';
import {
  INK_BRUSH_KINDS,
  brushPresetForKind,
  resolveBrushSpec,
} from './ink/brush.js';
import type { InkBrushOverrides, InkBrushSpec } from './ink/brush.js';
import type { CompiledInkStroke } from './ink/geometry.js';
import { compileInkStroke } from './ink/compiler.js';
import type { PackedCompiledInk } from './ink/packed-protocol.js';
// Runtime unpack for lazy rich materialization from packed geometry.
// `packed-protocol` never imports `objects`, so this cannot cycle.
import { unpackCompiledInk } from './ink/packed-protocol.js';
import { expandLogicalIds } from './logical-stroke.js';

/** Stored rotation in radians; 0 when absent or non-finite. */
function isLineArrows(value: unknown): value is LineArrows {
  return value === 'start' || value === 'end' || value === 'both';
}

export function rotationOf(record: SurfaceObjectRecord): number {
  return finiteNumber(record.rotation) ?? 0;
}

/** Loose envelope bounds for arbitrary records (placeholder/hit fallbacks). */
export function looseEnvelopeBounds(record: SurfaceObjectRecord): Bounds {
  const x = finiteNumber(record.x) ?? 0;
  const y = finiteNumber(record.y) ?? 0;
  const width = Math.max(finiteNumber(record.width) ?? 0, 0);
  const height = Math.max(finiteNumber(record.height) ?? 0, 0);
  return { x, y, width, height };
}

/**
 * Render-side opaque wrapper: a dashed-bounding-box placeholder carrying
 * the object's type label. Content is never dropped and never invented.
 */
export function placeholderFor(record: SurfaceObjectRecord): DrawItem {
  return {
    kind: 'placeholder',
    objectId: record.id,
    bounds: looseEnvelopeBounds(record),
    rotation: 0,
    label: typeof record.type === 'string' ? record.type : String(record.type),
  };
}

function fillOf(record: SurfaceObjectRecord): string | undefined {
  const fill = record.fill;
  return typeof fill === 'string' ? fill : undefined;
}

function sizedBounds(record: SurfaceObjectRecord): Bounds | null {
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  const width = finiteNumber(record.width);
  const height = finiteNumber(record.height);
  if (x === null || y === null || width === null || height === null)
    return null;
  if (width < 0 || height < 0) return null;
  return { x, y, width, height };
}

// --- Baseline descriptors ---

/**
 * Default connector-anchor resolution for envelope-bound objects
 * compute the named anchor in local object
 * coordinates, then rotate it around the canonical pivot (the envelope
 * center — the same pivot rendering and hit-testing use). Axis-aligned
 * envelopes degrade to the plain anchor point.
 */
export function sizedConnectorAnchor(
  record: SurfaceObjectRecord,
  anchor: ConnectorAnchor,
  boundsOf: (record: SurfaceObjectRecord) => Bounds | null,
): Point | null {
  const bounds = boundsOf(record);
  if (bounds === null) return null;
  const local = localAnchorPoint(bounds, anchor);
  const rotation = rotationOf(record);
  if (!Number.isFinite(rotation) || rotation === 0) return local;
  return rotateAround(local, centerOfBounds(bounds), rotation);
}

/** Named anchor on unrotated envelope bounds (local object coordinates). */
export function localAnchorPoint(
  bounds: Bounds,
  anchor: ConnectorAnchor,
): Point {
  switch (anchor) {
    case 'n':
      return { x: bounds.x + bounds.width / 2, y: bounds.y };
    case 's':
      return {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height,
      };
    case 'e':
      return {
        x: bounds.x + bounds.width,
        y: bounds.y + bounds.height / 2,
      };
    case 'w':
      return { x: bounds.x, y: bounds.y + bounds.height / 2 };
    case 'center':
    default:
      return {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      };
  }
}

function isLocked(record: SurfaceObjectRecord): boolean {
  return record.locked === true;
}

const rectangleObjectType: SurfaceObjectTypeDescriptor = {
  typeId: SURFACE_OBJECT_TYPES.rectangle,
  version: 1,
  boundsOf: sizedBounds,
  connectorAnchor: (record, anchor) =>
    sizedConnectorAnchor(record, anchor, (object) => {
      const bounds = sizedBounds(object);
      // At half height a triangle's sides are a quarter-width inset.
      return bounds !== null && object.shape === 'triangle'
        ? { ...bounds, x: bounds.x + bounds.width / 4, width: bounds.width / 2 }
        : bounds;
    }),
  hitTest: (record, x, y) => {
    if (isLocked(record)) return false;
    const bounds = sizedBounds(record);
    if (
      bounds !== null &&
      (record.shape === 'triangle' || record.shape === 'diamond')
    ) {
      const local = unrotateAround(
        { x, y },
        centerOfBounds(bounds),
        rotationOf(record),
      );
      const { x: bx, y: by, width: w, height: h } = bounds;
      const points =
        record.shape === 'triangle'
          ? [
              { x: bx + w / 2, y: by },
              { x: bx + w, y: by + h },
              { x: bx, y: by + h },
            ]
          : [
              { x: bx + w / 2, y: by },
              { x: bx + w, y: by + h / 2 },
              { x: bx + w / 2, y: by + h },
              { x: bx, y: by + h / 2 },
            ];
      return pointInPolygon(local, points);
    }
    return (
      bounds !== null &&
      pointInRotatedBounds(bounds, rotationOf(record), { x, y })
    );
  },
  compile: (record) => {
    const bounds = sizedBounds(record);
    if (bounds === null) return null;
    const fill = fillOf(record);
    const stroke =
      typeof record.stroke === 'string' ? record.stroke : undefined;
    const strokeWidth = finiteNumber(record.strokeWidth);
    return {
      kind: 'rect',
      ...(typeof record.cornerRadius === 'number'
        ? { cornerRadius: record.cornerRadius }
        : {}),
      ...(record.shape === 'triangle' ||
      record.shape === 'diamond' ||
      record.shape === 'rounded'
        ? { shape: record.shape }
        : {}),
      objectId: record.id,
      bounds,
      rotation: rotationOf(record),
      ...(fill !== undefined ? { fill } : {}),
      ...(stroke !== undefined ? { stroke } : {}),
      ...(strokeWidth !== null ? { strokeWidth } : {}),
    };
  },
};

const ellipseObjectType: SurfaceObjectTypeDescriptor = {
  typeId: SURFACE_OBJECT_TYPES.ellipse,
  version: 1,
  boundsOf: sizedBounds,
  connectorAnchor: (record, anchor) =>
    sizedConnectorAnchor(record, anchor, sizedBounds),
  hitTest: (record, x, y) => {
    if (isLocked(record)) return false;
    const bounds = sizedBounds(record);
    return (
      bounds !== null && pointInEllipse(bounds, rotationOf(record), { x, y })
    );
  },
  compile: (record) => {
    const bounds = sizedBounds(record);
    if (bounds === null) return null;
    const fill = fillOf(record);
    const stroke =
      typeof record.stroke === 'string' ? record.stroke : undefined;
    const strokeWidth = finiteNumber(record.strokeWidth);
    return {
      kind: 'ellipse',
      objectId: record.id,
      bounds,
      rotation: rotationOf(record),
      ...(fill !== undefined ? { fill } : {}),
      ...(stroke !== undefined ? { stroke } : {}),
      ...(strokeWidth !== null ? { strokeWidth } : {}),
    };
  },
};

/**
 * Surface text bounds: the derived envelope is a function
 * of `(x, y, effectiveSize, wrapped line boxes, appearance)` — per-line
 * `1.25 × effectiveSize`, `\n` breaks + valid `wrapWidth` soft breaks,
 * `boxWidth = wrapWidth || longest`, align-invariant, `(x, y)`
 * first-line origin, envelope-center pivot. See `textV2EstBounds` for
 * resolutions. Culling, selection, and hit areas derive from
 * this one envelope (tight, no padding).
 */
type SurfaceTextMeasure = (
  record: SurfaceObjectRecord,
  text: string,
  size: number,
) => number;

function textBounds(
  record: SurfaceObjectRecord,
  measure?: SurfaceTextMeasure,
): Bounds | null {
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  if (x === null || y === null || typeof record.text !== 'string') return null;
  return textV2EstBounds(
    { x, y, size: record.size, appearance: record.appearance },
    record.text,
    measure === undefined
      ? undefined
      : (text, size) => measure(record, text, size),
  );
}

const textObjectType: SurfaceObjectTypeDescriptor = {
  typeId: SURFACE_OBJECT_TYPES.text,
  version: 1,
  boundsOf: textBounds,
  connectorAnchor: (record, anchor) =>
    sizedConnectorAnchor(record, anchor, textBounds),
  hitTest: (record, x, y) => {
    if (isLocked(record)) return false;
    const bounds = textBounds(record);
    return (
      bounds !== null &&
      pointInRotatedBounds(bounds, rotationOf(record), { x, y })
    );
  },
  resize: (record, size) => {
    if (size.width === undefined) return false;
    (record as Record<string, unknown>).appearance = {
      ...(typeof record.appearance === 'object' && record.appearance !== null
        ? record.appearance
        : {}),
      wrapWidth: Math.max(24, size.width),
    };
    return true;
  },
  compile: (record) => {
    const bounds = textBounds(record);
    if (bounds === null || typeof record.text !== 'string') return null;
    const color = typeof record.color === 'string' ? record.color : undefined;
    // Surface text plain-data: effective
    // role/align/wrapWidth/bold/italic only — unknown wire values already
    // normalized to body/start/unbounded/inactive here, so backends branch
    // without payload knowledge. Verbatim preservation stays in the record
    // (codec keeps bytes, never normalizes on write). Size is the
    // appearance-first effective size so H1/H2 `appearance.size` writes
    // render and bound identically to top-level `size` writes.
    const role = textRoleOf(record);
    const align = textAlignOf(record);
    const wrapWidth = textWrapWidthOf(record);
    const bold = textBoldOf(record);
    const italic = textItalicOf(record);
    return {
      kind: 'text',
      objectId: record.id,
      bounds,
      rotation: rotationOf(record),
      text: record.text,
      size: effectiveSurfaceTextSizeOf(record),
      ...(color !== undefined ? { color } : {}),
      role,
      align,
      ...(wrapWidth !== null ? { wrapWidth } : {}),
      ...(bold === true ? { bold: true as const } : {}),
      ...(italic === true ? { italic: true as const } : {}),
    };
  },
};

const imageObjectType: SurfaceObjectTypeDescriptor = {
  typeId: SURFACE_OBJECT_TYPES.image,
  version: 1,
  boundsOf: sizedBounds,
  connectorAnchor: (record, anchor) =>
    sizedConnectorAnchor(record, anchor, sizedBounds),
  hitTest: (record, x, y) => {
    if (isLocked(record)) return false;
    const bounds = sizedBounds(record);
    return (
      bounds !== null &&
      pointInRotatedBounds(bounds, rotationOf(record), { x, y })
    );
  },
  compile: (record) => {
    const bounds = sizedBounds(record);
    if (bounds === null || typeof record.src !== 'string') return null;
    return {
      kind: 'image',
      objectId: record.id,
      bounds,
      rotation: rotationOf(record),
      src: record.src,
    };
  },
};

// --- Ink stroke ---

// Width/hit-tolerance constants live with the brush contract (ink/brush.js)
// so the geometry compiler can use them without a module cycle; they are
// re-exported here to keep the existing objects.js import seam stable.
import { INK_DEFAULT_WIDTH, INK_HIT_TOLERANCE } from './ink/brush.js';

export { INK_DEFAULT_WIDTH, INK_HIT_TOLERANCE };

/** Finite polyline samples of a record; empty when unusable. */
export function inkSamplesOf(record: SurfaceObjectRecord): Point[] {
  return inkTypedSamplesOf(record).map(({ x, y }) => ({ x, y }));
}

/** Samples preserving optional hardware axes (pressure/tilt/twist). */
export function inkTypedSamplesOf(record: SurfaceObjectRecord): InkSample[] {
  const points = record.points;
  if (!Array.isArray(points)) return [];
  const samples: InkSample[] = [];
  for (const raw of points) {
    if (typeof raw !== 'object' || raw === null) continue;
    const s = raw as Record<string, unknown>;
    const x = finiteNumber(s.x);
    const y = finiteNumber(s.y);
    if (x === null || y === null) continue;
    const tiltRaw = s.tilt as unknown;
    const tilt =
      typeof tiltRaw === 'object' && tiltRaw !== null && !Array.isArray(tiltRaw)
        ? (() => {
            const t = tiltRaw as Record<string, unknown>;
            const tx = finiteNumber(t.x);
            const ty = finiteNumber(t.y);
            return tx === null || ty === null ? undefined : { x: tx, y: ty };
          })()
        : undefined;
    // Unknown per-sample members survive (preservation contract): the
    // eraser path feeds these samples to split functions, so stripping
    // here would destroy extensible data on every erase.
    const sample: Record<string, unknown> = {
      x,
      y,
      ...(finiteNumber(s.pressure) !== null
        ? { pressure: s.pressure as number }
        : {}),
      ...(tilt !== undefined ? { tilt } : {}),
      ...(finiteNumber(s.twist) !== null ? { twist: s.twist as number } : {}),
      ...(finiteNumber(s.dt) !== null ? { dt: s.dt as number } : {}),
    };
    for (const [key, value] of Object.entries(s)) {
      if (
        key !== 'x' &&
        key !== 'y' &&
        key !== 'pressure' &&
        key !== 'tilt' &&
        key !== 'twist' &&
        key !== 'dt' &&
        !(key in sample)
      ) {
        sample[key] = value;
      }
    }
    samples.push(sample as unknown as InkSample);
  }
  return samples;
}

function inkWidthOf(record: SurfaceObjectRecord): number {
  const width = finiteNumber(record.width);
  return width !== null && width > 0 ? width : INK_DEFAULT_WIDTH;
}

/**
 * Resolve the rendering brush for one stroke record: the stored member
 * over its kind preset (record width as size), ball pen for legacy
 * strokes without a member. Defensive throughout — resolveBrushSpec
 * clamps every field, so invalid members degrade instead of throwing.
 * A stored `brush.size` is preserved verbatim but ignored: record width
 * stays the single canonical size. Exported so hit-testing, selection,
 * and erasure derive from the same resolved brush as rendering (repair
 * pass item 2: one authoritative envelope path).
 */
export function resolveStrokeBrush(record: SurfaceObjectRecord): InkBrushSpec {
  const stored =
    typeof record.brush === 'object' && record.brush !== null
      ? (record.brush as InkBrushOverrides)
      : {};
  const kindRaw = (stored as Record<string, unknown>).kind;
  const kind =
    typeof kindRaw === 'string' &&
    (INK_BRUSH_KINDS as readonly string[]).includes(kindRaw)
      ? kindRaw
      : 'ball';
  return resolveBrushSpec(
    { ...stored, kind: kind as InkBrushSpec['kind'], size: inkWidthOf(record) },
    brushPresetForKind(kind as InkBrushSpec['kind']),
  );
}

function inkStrokeBounds(record: SurfaceObjectRecord): Bounds | null {
  const region = inkRegion(record);
  if (region !== null) return regionBounds(region);
  // Cheap path (Slice 6): single pass over raw points, no InkSample[]/Point[]
  // allocation, no fingerprint hash. Cached O(1) hits live in the
  // controller's derived store / spatial index; this is the miss path.
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
  return inkSampleEnvelope(
    [
      { x: minX, y: minY },
      { x: maxX, y: maxY },
    ],
    maxStrokeHalfWidth(record),
  );
}

/**
 * Shared derived-geometry cache (Slice 6): explicit invalidation, no
 * fingerprint rescans for hits. Unchanged objects hit O(1) by object
 * identity without scanning samples; canonical mutation invalidates only
 * affected ids (controller/history call invalidateCompiledForIds).
 * Entries die with their records (WeakMap). Misses compile once (one
 * sample scan for the compile itself, never a separate fingerprint scan).
 */
const compiledStrokeCache = new WeakMap<object, CompiledInkStroke>();
const compiledNullCache = new WeakSet<object>();

/**
 * Retained packed compiled geometry per record (same versioned packed
 * representation the Worker/cache use). Filled by worker results and lazy
 * cache restores so teardown persistence can reuse the packed copy
 * instead of unpacking a JS object graph and repacking identical
 * geometry. LOCAL coordinates, like the compiled geometry it annotates:
 * persistence rebases by the accumulated derived translation. Cleared
 * whenever compiled geometry is invalidated or recompiled from canonical
 * samples.
 */
const packedCompiledByRecord = new WeakMap<object, PackedCompiledInk>();

/**
 * Packed-only retention for packed-rendered records (closure pass).
 * Packed restores stay in typed-array form (no rich `CompiledInkStroke`
 * installed) but must still be persistable: this map holds the packed copy
 * for records rendered as `PackedStrokeItem` without warming the rich
 * cache. Cleared on the same invalidation paths as the rich retention.
 */
const packedOnlyByRecord = new WeakMap<object, PackedCompiledInk>();

/**
 * Joint packed retention for logical multi-chunk strokes (closure item D).
 *
 * Logical chunks compile JOINTLY (one B-spline fit over concatenated
 * samples); the joint `PackedCompiledInk` is retained on EVERY chunk record
 * of the logical stroke (same reference, no duplication) so that:
 * - teardown persists one stable joint entry under the logical id (not one
 *   per chunk);
 * - member mutation invalidates the joint for the whole logical.
 *
 * Per-record derived geometry (rich / record-packed / packed-only) is a
 * SEPARATE owner from the joint: see `derivedTranslationByRecord` vs
 * `jointTranslationByPacked` below.
 *
 * LOCAL coordinates (like single packed retention); persistence rebases by
 * the JOINT translation (not an arbitrary chunk's record translation).
 * Cleared on the same invalidation paths as single retention (plus
 * logical-peer clearing).
 */
const jointPackedByChunk = new WeakMap<object, PackedCompiledInk>();

/**
 * Joint derived translation, owned by the JOINT packed geometry identity
 * (FINAL correctness closure, §2).
 *
 * Every chunk of a logical stroke holds the SAME `PackedCompiledInk`
 * reference for the joint. The joint's rigid translation lives here, keyed
 * by that shared packed object — exactly once per joint geometry:
 *
 *   joint created → transform starts 0
 *   joint translated → accumulates once
 *   joint invalidated → packed becomes unreachable → transform disappears
 *   joint reloaded from durable world geometry → new packed → starts 0
 *
 * Do NOT overload one chunk's `derivedTranslationByRecord` as the joint's
 * translation: a logical may simultaneously own joint geometry PLUS
 * independent per-chunk rich/packed geometry, which are DIFFERENT owners
 * and must translate independently.
 */
const jointTranslationByPacked = new WeakMap<
  object,
  { tx: number; ty: number }
>();

/**
 * Derived rigid translation per record (scalability final pass).
 *
 * Compiled Ink geometry is IMMUTABLE in local geometry coordinates: the
 * `compiledStrokeCache` entry is compiled once from canonical samples and
 * never rewritten by translation. A pure rigid translation instead
 * accumulates here (`tx`/`ty` in surface units) until the next
 * recompile/invalidation resets it. World position = local geometry +
 * this translation.
 *
 * Readers that need world coordinates (`smoothSpineOfRecord`,
 * `smoothSamplesOfRecord`, `inkStrokeCompiledBounds`, the Ink `compile`
 * outline, prepared-scene transforms) add this translation; predicates
 * that can map the query instead (hit-test broad phases via cached
 * bounds) stay O(1) without touching vertices.
 */
const derivedTranslationByRecord = new WeakMap<
  object,
  { tx: number; ty: number }
>();

/**
 * Structural diagnostics (scalability gates): authoritative stroke
 * compilations performed (cache misses). Hit-test/selection paths must
 * not inflate this for non-containing strokes — the Ink hit-test
 * broad- spine compilation exactly.
 */
export const compiledStrokeComputeStats = { computes: 0, translates: 0 };

/**
 * Geometry mutation generation (background-pack staleness contract).
 *
 * Every geometry-affecting canonical mutation advances these epochs at the
 * single invalidation boundary (`invalidateCompiledForIds` /
 * `invalidateCompiledForRecord`). Pure translation (`accumulateDerived-
 * Translation`) never touches them, preserving zero-copy/no-recompile
 * translation.
 *
 * State is scoped by Surface model identity. Each model owns record and
 * logical epochs plus remembered old chunk ownership, so identical ids in
 * concurrently open documents cannot affect one another and closed models
 * remain weakly collectible.
 *
 * Background jobs capture the relevant epochs at creation and the Worker
 * request carries the meaningful epoch (never a hardcoded 0, never an
 * unrelated request counter). Completion installs only when every captured
 * epoch is still current.
 */
interface GeometryGenerationState {
  readonly recordGenerationById: Map<string, number>;
  readonly logicalGenerationById: Map<string, number>;
  /**
   * Background-pack position/translation epoch (race fix).
   *
   * Geometry generations deliberately do NOT change on rigid translation
   * (zero-copy translation must not recompile B-splines). Background
   * logical packing copies canonical coordinates across multiple idle
   * slices, so a translation between slices (or while a Worker request is
   * in flight) would otherwise pass every geometry/identity/count check
   * and install stale or mixed-coordinate packed geometry.
   *
   * These epochs advance ONLY on rigid translation (via
   * `accumulateDerivedTranslation`), never on geometry edits, and are
   * consulted ONLY to reject stale background/cold async work — never to
   * force recompilation.
   */
  readonly recordPositionById: Map<string, number>;
  readonly logicalPositionById: Map<string, number>;
  readonly oldLogicalOwnershipByRecordId: Map<string, string | null>;
  readonly preMutationRecordById: Map<string, SurfaceObjectRecord>;
  /**
   * Pending REPLACED-AWAY logicals per record id (rapid-replacement fix).
   *
   * `oldLogicalOwnershipByRecordId` is overwritten with the NEW logical on
   * every invalidation (so the next mutation's old lookup stays current).
   * For L→single / L→M replacement that would lose the old survivor. This
   * map retains EVERY still-relevant unacknowledged old logical per record
   * (rapid B:L→M→N accumulates {L,M}, never overwrites L with M), letting
   * the commit/prepared rendezvous republish ALL surviving old logicals plus
   * the new unit. Keyed by stable id, model-scoped, bounded by mutated ids
   * / pending count (never a document scan, never global, never time-based).
   * Deletions need no new entry (the remembered mapping already keeps the
   * old logical); the set for a deleted id is kept until ack retires it.
   *
   * Retirement is explicit and incremental: entries leave only via
   * `acknowledgeBackgroundPackRendezvousKeys` after the survivor publication
   * safely crosses the commit/prepared rendezvous (including the no-survivor
   * drop path), or synchronously when the CURRENT logical reappears in the
   * set (return-to-old: it is no longer historical). Same-logical edits add
   * nothing and clear nothing (historiques survive until ack). Per-record
   * sets keep shared logicals safe: two records leaving one L each hold
   * their own {L}, so retiring one record's entry never deletes state
   * another record still needs (global ack for `l:L` removes it from every
   * holder only after L's survivor succeeds, which satisfies all holders).
   */
  readonly replacedOldLogicalsByRecordId: Map<string, Set<string>>;
  /**
   * Reverse historical-holder index (`logicalId → record ids`), model-scoped.
   *
   * Maintained in lockstep with `replacedOldLogicalsByRecordId` via the
   * edge helpers below. Invariant: forward contains (recordId, logicalId)
   * IFF reverse contains (logicalId, recordId); empty sets are deleted in
   * both directions so neither map grows without bound. Internal only —
   * never re-exported via `surfaces/index.ts`; retirement reads holders
   * through this index instead of scanning all pending record ids.
   * Retirement-only: key generation still reads the record-local forward
   * set, never this reverse map.
   */
  readonly replacedOldRecordIdsByLogical: Map<string, Set<string>>;
  /**
   * Model-scoped CURRENT logical membership (`logicalId → record ids`),
   * seeded lazily once from canonical state and maintained at the
   * invalidation boundary. Lets invalidation clear joint retention for the
   * peers of an affected logical in O(mutated logical members) instead of
   * scanning every document object, and lets background-pack scheduling
   * resolve a prepared logical's member records without a full-document
   * scan. WeakMap-owned through the model identity; never global.
   */
  readonly logicalMembersById: Map<string, Set<string>>;
  /** Reverse membership for O(1) old-logical lookup during mutation. */
  readonly logicalByRecordId: Map<string, string>;
  /** False until the canonical model has been indexed once (lazy seed). */
  logicalMembersSeeded: boolean;
}

let geometryGenerationByModel = new WeakMap<object, GeometryGenerationState>();

function geometryState(
  model: Pick<SurfaceModel, 'objects'>,
): GeometryGenerationState {
  const key = model as object;
  let state = geometryGenerationByModel.get(key);
  if (state === undefined) {
    state = {
      recordGenerationById: new Map(),
      logicalGenerationById: new Map(),
      recordPositionById: new Map(),
      logicalPositionById: new Map(),
      oldLogicalOwnershipByRecordId: new Map(),
      replacedOldLogicalsByRecordId: new Map(),
      replacedOldRecordIdsByLogical: new Map(),
      preMutationRecordById: new Map(),
      logicalMembersById: new Map(),
      logicalByRecordId: new Map(),
      logicalMembersSeeded: false,
    };
    geometryGenerationByModel.set(key, state);
  }
  return state;
}

/** Canonical records of one model (loose shape; reads `type`/`id`/logical id only). */
function modelObjects(
  model: Pick<SurfaceModel, 'objects'>,
): Record<string, SurfaceObjectRecord | undefined> {
  return (model as { objects: Record<string, SurfaceObjectRecord | undefined> })
    .objects;
}

/**
 * Historical replacement edge helpers (edge-proportional retirement).
 *
 * The forward map (`replacedOldLogicalsByRecordId`: record → historical
 * logicals) and the reverse map (`replacedOldRecordIdsByLogical`:
 * logical → holder records) always change together. Invariant: forward
 * contains (recordId, logicalId) IFF reverse contains (logicalId,
 * recordId). Every helper maintains both directions and deletes empty
 * sets in both indexes so neither map retains dangling entries.
 * All helpers are idempotent via Set semantics and never throw.
 */
function addReplacedLogicalEdge(
  state: GeometryGenerationState,
  recordId: string,
  logicalId: string,
): void {
  if (recordId.length === 0 || logicalId.length === 0) return;
  try {
    let forward = state.replacedOldLogicalsByRecordId.get(recordId);
    if (forward === undefined) {
      forward = new Set();
      state.replacedOldLogicalsByRecordId.set(recordId, forward);
    }
    forward.add(logicalId);
    let reverse = state.replacedOldRecordIdsByLogical.get(logicalId);
    if (reverse === undefined) {
      reverse = new Set();
      state.replacedOldRecordIdsByLogical.set(logicalId, reverse);
    }
    reverse.add(recordId);
  } catch {
    // Survivor bookkeeping never breaks invalidation.
  }
}

function removeReplacedLogicalEdge(
  state: GeometryGenerationState,
  recordId: string,
  logicalId: string,
): void {
  if (recordId.length === 0 || logicalId.length === 0) return;
  try {
    const forward = state.replacedOldLogicalsByRecordId.get(recordId);
    if (forward !== undefined) {
      forward.delete(logicalId);
      if (forward.size === 0) {
        try {
          state.replacedOldLogicalsByRecordId.delete(recordId);
        } catch {
          // Ignore.
        }
      }
    }
  } catch {
    // Ignore.
  }
  try {
    const reverse = state.replacedOldRecordIdsByLogical.get(logicalId);
    if (reverse !== undefined) {
      reverse.delete(recordId);
      if (reverse.size === 0) {
        try {
          state.replacedOldRecordIdsByLogical.delete(logicalId);
        } catch {
          // Ignore.
        }
      }
    }
  } catch {
    // Ignore.
  }
}

/**
 * Retire one historical logical across its holders only.
 *
 * Looks up holders via the reverse index (`logicalId → record ids`) and
 * removes the (holder, logical) edge per holder through
 * `removeReplacedLogicalEdge` (both directions, empty sets deleted).
 * Returns the number of edges retired. Never enumerates
 * `replacedOldLogicalsByRecordId`, `model.objects`, or `model.order`.
 */
function retireReplacedLogical(
  state: GeometryGenerationState,
  logicalId: string,
): number {
  if (logicalId.length === 0) return 0;
  let holders: string[] | undefined;
  try {
    const set = state.replacedOldRecordIdsByLogical.get(logicalId);
    if (set === undefined || set.size === 0) return 0;
    holders = [...set];
  } catch {
    return 0;
  }
  let retired = 0;
  for (const holder of holders) {
    try {
      replacedEdgeRetirementStats.holderVisits += 1;
    } catch {
      // Stats never break retirement.
    }
    try {
      const forward = state.replacedOldLogicalsByRecordId.get(holder);
      const hadEdge = forward !== undefined ? forward.has(logicalId) : false;
      removeReplacedLogicalEdge(state, holder, logicalId);
      if (hadEdge) {
        retired += 1;
        try {
          replacedEdgeRetirementStats.edgeVisits += 1;
        } catch {
          // Ignore.
        }
      }
    } catch {
      // Per-holder retirement never breaks acknowledgement.
    }
  }
  return retired;
}

/**
 * Test-only retirement visit diagnostics (regression seam).
 *
 * Counts holders/edges actually visited by `retireReplacedLogical` during
 * `acknowledgeBackgroundPackRendezvousKeys`. Production never reads these
 * counters. Test-only: do NOT re-export via `surfaces/index.ts`; specs
 * import them directly from `./objects.js` so the barrel public API is
 * unchanged.
 */
export const replacedEdgeRetirementStats: {
  holderVisits: number;
  edgeVisits: number;
} = { holderVisits: 0, edgeVisits: 0 };

/** Test-only: reset retirement visit diagnostics (isolates ack assertions). */
export function resetReplacedEdgeRetirementStatsForTests(): void {
  replacedEdgeRetirementStats.holderVisits = 0;
  replacedEdgeRetirementStats.edgeVisits = 0;
}

/**
 * Test-only snapshot of both replacement indexes (consistency seam).
 *
 * Returns sorted plain-object copies (`recordId → sorted logicals`,
 * `logicalId → sorted holder record ids`) without exposing the live
 * Maps. Lets regressions assert forward-IFF-reverse and empty-set
 * deletion without widening the barrel public API: do NOT re-export via
 * `surfaces/index.ts`; import directly from `./objects.js`.
 * Never throws; unknown models yield empty snapshots.
 */
export function inspectReplacedEdgesForTests(
  model: Pick<SurfaceModel, 'objects'>,
): {
  readonly forward: Record<string, string[]>;
  readonly reverse: Record<string, string[]>;
} {
  const forward: Record<string, string[]> = {};
  const reverse: Record<string, string[]> = {};
  try {
    const state = geometryState(model);
    for (const [recordId, set] of state.replacedOldLogicalsByRecordId) {
      forward[recordId] = [...set].sort();
    }
    for (const [logicalId, set] of state.replacedOldRecordIdsByLogical) {
      reverse[logicalId] = [...set].sort();
    }
  } catch {
    // Snapshot never breaks tests.
  }
  return { forward, reverse };
}

function addLogicalMember(
  state: GeometryGenerationState,
  record: SurfaceObjectRecord,
): void {
  let logical: string | null = null;
  try {
    logical = logicalIdOf(record);
  } catch {
    logical = null;
  }
  if (logical === null) return;
  const id = record.id;
  const existing = state.logicalByRecordId.get(id);
  if (existing === logical) return;
  if (existing !== undefined) removeLogicalMember(state, id);
  let members = state.logicalMembersById.get(logical);
  if (members === undefined) {
    members = new Set();
    state.logicalMembersById.set(logical, members);
  }
  members.add(id);
  state.logicalByRecordId.set(id, logical);
}

function removeLogicalMember(
  state: GeometryGenerationState,
  id: string,
): string | null {
  const logical = state.logicalByRecordId.get(id);
  if (logical === undefined) return null;
  state.logicalByRecordId.delete(id);
  const members = state.logicalMembersById.get(logical);
  if (members === undefined) return logical;
  members.delete(id);
  if (members.size === 0) state.logicalMembersById.delete(logical);
  return logical;
}

/**
 * True when any id in the batch touches logical membership (current or
 * remembered): only then is the O(objects) seed needed. Documents that only
 * ever contain independent strokes never pay for the membership index.
 */
function needsLogicalMembership(
  model: Pick<SurfaceModel, 'objects'>,
  state: GeometryGenerationState,
  ids: readonly string[],
): boolean {
  const objects = modelObjects(model);
  for (const id of ids) {
    // A remembered mapping only matters when it names a real logical; plain
    // single records store an inert `null` marker and must not build the
    // index (a single-only document never pays for it).
    if (
      state.oldLogicalOwnershipByRecordId.has(id) &&
      (state.oldLogicalOwnershipByRecordId.get(id) ?? null) !== null
    ) {
      return true;
    }
    const record = objects[id];
    if (record === undefined) continue;
    try {
      if (logicalIdOf(record) !== null) return true;
    } catch {
      // Malformed records never require the index.
    }
  }
  return false;
}

/**
 * Seed the membership index once from current canonical state (O(objects)
 * logicalId reads, no sample scans). Subsequent mutations maintain the
 * index incrementally, so no per-mutation full-document scan is added and
 * single-only documents never build the index at all.
 */
function ensureLogicalMembers(
  model: Pick<SurfaceModel, 'objects'>,
  state: GeometryGenerationState,
): void {
  if (state.logicalMembersSeeded) return;
  state.logicalMembersSeeded = true;
  try {
    const objects = modelObjects(model);
    for (const key of Object.keys(objects)) {
      const record = objects[key];
      if (record === undefined) continue;
      addLogicalMember(state, record);
    }
  } catch {
    // Seeding never breaks mutation; a partial index degrades safely
    // (peers of an unseeded logical simply keep stale retention until
    // their own id is mutated).
  }
}

/**
 * Current canonical member ids of one logical stroke, from the model-scoped
 * membership index (seeded lazily on first use). Order is index insertion
 * order; callers that need canonical gesture order sort by `chunkIndex`.
 */
export function logicalMembersOf(
  model: Pick<SurfaceModel, 'objects'>,
  logicalId: string,
): string[] {
  const state = geometryState(model);
  ensureLogicalMembers(model, state);
  const members = state.logicalMembersById.get(logicalId);
  return members === undefined ? [] : [...members];
}

/**
 * Discriminated background-pack scheduling unit (scene preparation truth).
 *
 * A single canonical stroke is scheduled through the ordinary record path;
 * a logical stroke spanning several canonical chunks is scheduled as ONE
 * unit (joint Worker compile/pack, one retained joint on every member).
 * The committed scene may have prepared a logical joint without any
 * individual chunk owning rich compiled geometry, so logical units must
 * not be forced through the per-record warm/rich requirement.
 */
export type PreparedBackgroundPackUnit =
  | {
      readonly kind: 'single';
      readonly record: SurfaceObjectRecord;
    }
  | {
      readonly kind: 'logical';
      readonly logicalId: string;
      readonly records: readonly SurfaceObjectRecord[];
    };

/**
 * Resolve the prepared background-pack unit that owns `id`: a single
 * canonical record, or the current chunked members of its logical stroke
 * (canonical order preserved by `chunkIndex`). Returns null for missing
 * records and non-Ink objects (never background-pack irrelevant types).
 *
 * This is the "scene preparation truth" seam: callers invoke it only for
 * ids the committed scene has prepared, so for logicals the scene has
 * already proven the rendered/compiled joint; the unit is expressed in
 * canonical membership terms, not per-chunk rich-cache terms.
 */
export function resolvePreparedBackgroundPackUnit(
  model: Pick<SurfaceModel, 'objects'>,
  id: string,
): PreparedBackgroundPackUnit | null {
  try {
    const record = modelObjects(model)[id];
    if (record === undefined) return null;
    if (record.type !== SURFACE_OBJECT_TYPES.stroke) return null;
    const logical = logicalIdOf(record);
    if (logical === null) return { kind: 'single', record };
    const objects = modelObjects(model);
    const records: SurfaceObjectRecord[] = [];
    const seen = new Set<string>();
    for (const memberId of logicalMembersOf(model, logical)) {
      const member = objects[memberId];
      if (member === undefined || seen.has(memberId)) continue;
      try {
        if (logicalIdOf(member) !== logical) continue;
      } catch {
        continue;
      }
      seen.add(memberId);
      records.push(member);
    }
    // The resolved id itself must be part of its logical unit even if the
    // membership index has not observed it yet.
    if (!seen.has(record.id)) records.push(record);
    records.sort((a, b) => {
      const ai = chunkIndexOf(a) ?? 0;
      const bi = chunkIndexOf(b) ?? 0;
      return ai - bi;
    });
    return { kind: 'logical', logicalId: logical, records };
  } catch {
    return null;
  }
}

/**
 * Remembered logical ownership for one record id (pre-mutation capture).
 * Returns the logical id when the record was (or still is) a chunk of a
 * logical stroke, null when it was a single / never logical, by consulting
 * the model-scoped capture map. Used by the commit/prepared rendezvous to
 * republish a surviving logical unit even when the directly mutated id no
 * longer exists (deletion) or now belongs elsewhere (replacement).
 */
export function rememberedLogicalIdOf(
  model: Pick<SurfaceModel, 'objects'>,
  id: string,
): string | null {
  try {
    const state = geometryState(model);
    if (state.oldLogicalOwnershipByRecordId.has(id)) {
      return state.oldLogicalOwnershipByRecordId.get(id) ?? null;
    }
    const record = modelObjects(model)[id];
    if (record === undefined) return null;
    try {
      return logicalIdOf(record);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Resolve the current prepared unit for a logical id directly (survivor
 * path): gathers CURRENT canonical members from the model-scoped
 * membership index, requires at least one live stroke chunk still
 * belonging to the logical, preserves `chunkIndex` order. Returns null
 * when the logical has no surviving members (fully deleted) or members
 * are non-stroke. Never scans the document beyond the indexed member set.
 */
export function resolvePreparedBackgroundPackUnitForLogical(
  model: Pick<SurfaceModel, 'objects'>,
  logicalId: string,
): PreparedBackgroundPackUnit | null {
  try {
    if (logicalId.length === 0) return null;
    const objects = modelObjects(model);
    const records: SurfaceObjectRecord[] = [];
    const seen = new Set<string>();
    for (const memberId of logicalMembersOf(model, logicalId)) {
      if (seen.has(memberId)) continue;
      const member = objects[memberId];
      if (member === undefined) continue;
      if (member.type !== SURFACE_OBJECT_TYPES.stroke) continue;
      try {
        if (logicalIdOf(member) !== logicalId) continue;
      } catch {
        continue;
      }
      seen.add(memberId);
      records.push(member);
    }
    if (records.length === 0) return null;
    records.sort((a, b) => {
      const ai = chunkIndexOf(a) ?? 0;
      const bi = chunkIndexOf(b) ?? 0;
      return ai - bi;
    });
    return { kind: 'logical', logicalId, records };
  } catch {
    return null;
  }
}

/**
 * Discriminated background-pack rendezvous key (survivor fix).
 *
 * A surviving logical unit must remain representable even when the directly
 * mutated id no longer exists (deletion) or now belongs elsewhere
 * (replacement). Encoded as `r:<id>` for singles and `l:<logicalId>` for
 * logicals so the commit/prepared rendezvous (which may live outside this
 * module) can match on stable strings without document scans.
 */
export type BackgroundPackRendezvousKey =
  | { readonly kind: 'record'; readonly id: string }
  | { readonly kind: 'logical'; readonly logicalId: string };

/** Encode a rendezvous key for Set storage (`r:` / `l:` prefixes). */
export function encodeBackgroundPackRendezvousKey(
  key: BackgroundPackRendezvousKey,
): string {
  return key.kind === 'record' ? `r:${key.id}` : `l:${key.logicalId}`;
}

/** Decode an encoded rendezvous key (null for malformed). */
export function decodeBackgroundPackRendezvousKey(
  encoded: string,
): BackgroundPackRendezvousKey | null {
  if (encoded.startsWith('r:') && encoded.length > 2) {
    return { kind: 'record', id: encoded.slice(2) };
  }
  if (encoded.startsWith('l:') && encoded.length > 2) {
    return { kind: 'logical', logicalId: encoded.slice(2) };
  }
  return null;
}

/**
 * Map mutated record ids to rendezvous keys (survivor path, multi-set).
 *
 * Ownership candidates are emitted INDEPENDENTLY (Option A): every
 * still-pending replaced-away old logical (accumulated at the invalidation
 * boundary, insertion-ordered per record) and the remembered pre-mutation
 * logical each publish `l:<logical>` when they name a real logical different
 * from the current one. `seen` dedups the overlap (pending ∋ remembered, or
 * either === current is skipped). Deleted ids resolve to pending/remembered
 * survivors (or drop when never logical). Live non-stroke replacements keep
 * those old emissions but contribute no current-unit key (they never enter
 * Ink background packing). Live singles map to `r:<id>`; live chunks map to
 * `l:<logical>` plus old survivors when replacement changed membership
 * (L→single / L→M / L→non-stroke, including rapid chains like L→M→N which
 * yield l:L,l:M,l:N). Uses the model-scoped membership/ownership index —
 * never a document scan. Tombstone lifetime is unchanged (Option A) except
 * for the explicit incremental retirement seam
 * (`acknowledgeBackgroundPackRendezvousKeys`): no O(document) cleanup pass,
 * never global mutable, never time-based expiry.
 */
export function backgroundPackRendezvousKeysForIds(
  model: Pick<SurfaceModel, 'objects'>,
  ids: readonly string[],
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const push = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };
  const objects = modelObjects(model);
  let state: GeometryGenerationState | null = null;
  try {
    state = geometryState(model);
  } catch {
    state = null;
  }
  for (const id of ids) {
    const record = objects[id];
    // Current stroke membership (null for deleted / non-stroke records).
    let currentLogical: string | null = null;
    if (record !== undefined && record.type === SURFACE_OBJECT_TYPES.stroke) {
      try {
        currentLogical = logicalIdOf(record);
      } catch {
        currentLogical = null;
      }
    }
    // (1) Old logical ownership FIRST, independently of the current type:
    // every still-pending replaced-away logical plus the remembered
    // candidate emit as independent branches (Option A multi-set). `seen`
    // dedups the overlap. Insertion order per record keeps rapid chains
    // deterministic (L→M→N yields l:L,l:M before the current l:N).
    try {
      const pending = state?.replacedOldLogicalsByRecordId.get(id);
      if (pending !== undefined) {
        for (const replaced of pending) {
          if (replaced.length > 0 && replaced !== currentLogical) {
            push(`l:${replaced}`);
          }
        }
      }
      const remembered = rememberedLogicalIdOf(model, id);
      if (
        remembered !== null &&
        remembered.length > 0 &&
        remembered !== currentLogical
      ) {
        push(`l:${remembered}`);
      }
    } catch {
      // Probing never breaks commits.
    }
    // (2) Current unit: deleted records are done after the old emission;
    // non-stroke records stop here (no r:/l: key for the replacement
    // itself, but the old emission above is kept).
    if (record === undefined) continue;
    if (record.type !== SURFACE_OBJECT_TYPES.stroke) continue;
    if (currentLogical === null) {
      push(`r:${id}`);
    } else {
      push(`l:${currentLogical}`);
    }
  }
  return keys;
}

/**
 * Acknowledge successfully published rendezvous keys and retire their
 * pending replaced-away state (edge-proportional incremental retirement).
 *
 * Call after a survivor publication safely crosses the commit/prepared
 * rendezvous: the production caller is `scheduleBackgroundPackRendezvous`
 * in `packages/editor-ink/src/surface.ts`, which passes its `consumed` keys
 * (scheduled logical/single units plus no-survivor drops) after deleting
 * them from both pending domains. Supplies the encoded keys
 * (`l:<logical>` / `r:<id>`) whose units were scheduled — INCLUDING `l:`
 * keys dropped as fully deleted / non-stroke (no-survivor case: nothing
 * left to republish, so retire).
 *
 * Semantics (production rendezvous lifecycle unchanged):
 * - each successfully scheduled logical (`consumed` `l:<logical>`) retires
 *   that logical from its holders only (shared-logical safe: B:L→M and
 *   C:L→N each hold {L}; retiring `l:L` after the survivor succeeds
 *   satisfies both holders at once; per-record sets mean retiring one
 *   logical never deletes a different pending logical another record still
 *   needs);
 * - a `l:` key consumed because no surviving unit remains retires the same
 *   way (nothing left to republish);
 * - a logical whose unit fails to schedule (`scheduleBackgroundPack…`
 *   returns false) is never added to `consumed`, so it is NOT retired and
 *   stays pending for a later prepared pass;
 * - empty per-record sets and empty reverse holder sets are deleted so both
 *   maps shrink (no unbounded growth; assert via rendezvous keys no longer
 *   containing the retired logical);
 * - `r:<id>` and malformed keys are ignored (a single's pack success never
 *   retires old logicals — their survivors still need their own `l:` ack);
 * - historical replacement acknowledgement does not enumerate
 *   model.objects or unrelated pending-holder sets: each `l:<logical>`
 *   visits only its reverse-index holders, so retirement is proportional
 *   to acknowledged historical ownership edges (O(acknowledged logical
 *   keys + historical edges actually retired), subject to Map/Set ops),
 *   never O(document) and never O(acked × pending ids). Key generation
 *   (`backgroundPackRendezvousKeysForIds`) still reads the record-local
 *   forward set; the reverse index exists for retirement efficiency only.
 * Never throws; unknown models/keys are no-ops.
 */
export function acknowledgeBackgroundPackRendezvousKeys(
  model: Pick<SurfaceModel, 'objects'>,
  acknowledgedKeys: readonly string[],
): void {
  if (acknowledgedKeys.length === 0) return;
  let state: GeometryGenerationState;
  try {
    state = geometryState(model);
  } catch {
    return;
  }
  const toRetire = new Set<string>();
  for (const key of acknowledgedKeys) {
    try {
      if (typeof key !== 'string') continue;
      if (key.startsWith('l:') && key.length > 2) {
        const logical = key.slice(2);
        if (logical.length > 0) toRetire.add(logical);
      }
      // `r:` keys intentionally retire nothing (documented above).
    } catch {
      // Key probing never breaks acknowledgement.
    }
  }
  if (toRetire.size === 0) return;
  try {
    for (const logical of toRetire) {
      try {
        retireReplacedLogical(state, logical);
        // Non-empty holder sets stay (other historiques still pending).
      } catch {
        // Per-logical retirement never breaks acknowledgement.
      }
    }
  } catch {
    // Acknowledgement never breaks callers.
  }
}

/** Current geometry epoch for one record id (0 when never invalidated). */
export function recordGeometryGeneration(
  model: Pick<SurfaceModel, 'objects'>,
  id: string,
): number {
  return geometryState(model).recordGenerationById.get(id) ?? 0;
}

/** Current geometry epoch for one logical stroke id (0 when never invalidated). */
export function logicalGeometryGeneration(
  model: Pick<SurfaceModel, 'objects'>,
  logicalId: string,
): number {
  return geometryState(model).logicalGenerationById.get(logicalId) ?? 0;
}

/**
 * Current background-pack position epoch for one record id (0 when never
 * translated). Advances on rigid translation via
 * `accumulateDerivedTranslation`; never advances on geometry edits and
 * never forces B-spline recompilation. Model-scoped like geometry
 * generations so identical ids in concurrently open documents stay
 * isolated.
 */
export function recordPositionGeneration(
  model: Pick<SurfaceModel, 'objects'>,
  id: string,
): number {
  return geometryState(model).recordPositionById.get(id) ?? 0;
}

/**
 * Current background-pack position epoch for one logical stroke id (0 when
 * never translated). Advanced exactly once per logical translation (plus
 * per-member record positions); consulted only to reject stale
 * background/cold async work.
 */
export function logicalPositionGeneration(
  model: Pick<SurfaceModel, 'objects'>,
  logicalId: string,
): number {
  return geometryState(model).logicalPositionById.get(logicalId) ?? 0;
}

/** Test seam: clear all geometry epochs (isolates generation assertions). */
export function resetGeometryGenerationsForTests(): void {
  geometryGenerationByModel = new WeakMap();
  try {
    replacedEdgeRetirementStats.holderVisits = 0;
    replacedEdgeRetirementStats.edgeVisits = 0;
  } catch {
    // Reset never breaks tests.
  }
}

function bumpRecordGeometryGeneration(
  state: GeometryGenerationState,
  id: string,
): number {
  const next = (state.recordGenerationById.get(id) ?? 0) + 1;
  state.recordGenerationById.set(id, next);
  return next;
}

function bumpLogicalGeometryGeneration(
  state: GeometryGenerationState,
  logicalId: string,
): number {
  const next = (state.logicalGenerationById.get(logicalId) ?? 0) + 1;
  state.logicalGenerationById.set(logicalId, next);
  return next;
}

function bumpRecordPositionGeneration(
  state: GeometryGenerationState,
  id: string,
): number {
  const next = (state.recordPositionById.get(id) ?? 0) + 1;
  state.recordPositionById.set(id, next);
  return next;
}

function bumpLogicalPositionGeneration(
  state: GeometryGenerationState,
  logicalId: string,
): number {
  const next = (state.logicalPositionById.get(logicalId) ?? 0) + 1;
  state.logicalPositionById.set(logicalId, next);
  return next;
}

/** Capture logical ownership while the pre-mutation records still exist. */
export function captureGeometryOwnershipForIds(
  model: Pick<SurfaceModel, 'objects'>,
  ids: readonly string[],
): void {
  const state = geometryState(model);
  // Seed BEFORE the mutation (only when a logical is involved) so old
  // logical membership is known even when this mutation replaces/deletes
  // the record before invalidation runs.
  if (
    !state.logicalMembersSeeded &&
    needsLogicalMembership(model, state, ids)
  ) {
    ensureLogicalMembers(model, state);
  }
  for (const id of ids) {
    const record = model.objects[id];
    if (record === undefined || state.preMutationRecordById.has(id)) continue;
    try {
      state.oldLogicalOwnershipByRecordId.set(id, logicalIdOf(record));
      state.preMutationRecordById.set(id, record);
    } catch {
      // Ownership capture never breaks canonical mutation.
    }
  }
}

/**
 * Ink compiler version for derived-cache keying: bump when
 * `compileInkStroke` output semantics change so stale cached geometry
 * is never reused across upgrades. Canonical payloads are unaffected.
 */
export const INK_COMPILER_VERSION = 2;

/**
 * Estimated preparation cost for first-paint budgeting (item 2): raw
 * canonical sample count for Ink strokes (the dominant compile cost),
 * 1 for all other object types. Never allocates or scans samples beyond
 * a length read — callers sum per record without touching geometry.
 */
export function estimatePrepareCost(record: SurfaceObjectRecord): number {
  if (record.type !== SURFACE_OBJECT_TYPES.stroke) return 1;
  const points = (record as Record<string, unknown>).points;
  return Array.isArray(points) ? Math.max(points.length, 1) : 1;
}

/** Invalidate compiled geometry for mutated records (explicit, no scans). */
export function invalidateCompiledForIds(
  model: Pick<SurfaceModel, 'objects'>,
  ids: readonly string[],
): void {
  const state = geometryState(model);
  // Seed the model-scoped membership index once, only when this batch
  // touches logical membership (O(objects) logicalId reads). Maintained
  // incrementally below, so invalidation never scans the document.
  if (
    !state.logicalMembersSeeded &&
    needsLogicalMembership(model, state, ids)
  ) {
    ensureLogicalMembers(model, state);
  }
  // Collect logical ids affected (for joint retention clearing below).
  const affectedLogicals = new Set<string>();
  // Joint packed identities whose retention is being dropped: their joint
  // translation must also be dropped so a future joint with the same object
  // identity can never inherit stale translation. (Normally the packed
  // becomes unreachable and the WeakMap entry disappears; explicit deletion
  // covers reuse of the same packed reference.)
  const droppedJoints = new Set<object>();
  const changedLogicalSources = new Set<string>();
  for (const id of new Set(ids)) {
    // Geometry epoch: bumped for EVERY id, including deleted/missing ones,
    // so an outstanding background job holding the old reference (or the
    // old id) observes a mismatch. Keyed by stable id string, never by the
    // (possibly detached/replaced) JS object.
    bumpRecordGeometryGeneration(state, id);
    // Drop the id from its previous logical membership before reading the
    // current record: covers deletion and same-id replacement (old logical
    // still removable via the reverse index) without any document scan.
    // The returned previous logical is a fallback when no pre-mutation
    // capture ran: its epoch must still advance and its peers still clear.
    const previousLogical = removeLogicalMember(state, id);
    const record = modelObjects(model)[id];
    const preMutationRecord = state.preMutationRecordById.get(id);
    // Remembered logical mapping covers deletion (record gone) and same-id
    // replacement (old logical overwritten by the new record before we read
    // it): both old and new logical epochs must advance.
    const remembered = state.oldLogicalOwnershipByRecordId.has(id)
      ? (state.oldLogicalOwnershipByRecordId.get(id) ?? null)
      : null;
    const rememberedKnown = state.oldLogicalOwnershipByRecordId.has(id);
    // Erasure replaces a record but leaves its semantic source untouched.
    // Keep that immutable source derivation; generations still advance so
    // outstanding jobs cannot publish against the retired record owner.
    const sameSource =
      record !== undefined &&
      preMutationRecord !== undefined &&
      record !== preMutationRecord &&
      record.type === SURFACE_OBJECT_TYPES.stroke &&
      record.points === preMutationRecord.points &&
      record.brush === preMutationRecord.brush &&
      record.width === preMutationRecord.width &&
      record.color === preMutationRecord.color &&
      record.opacity === preMutationRecord.opacity;
    if (!sameSource) {
      const oldLogical =
        preMutationRecord === undefined ? null : logicalIdOf(preMutationRecord);
      const newLogical = record === undefined ? null : logicalIdOf(record);
      if (oldLogical !== null) changedLogicalSources.add(oldLogical);
      if (newLogical !== null) changedLogicalSources.add(newLogical);
    }
    // Eraser-created replacements already carry an immutable derivation of
    // their unchanged source, including fresh independently-owned copies.
    const retainedReplacement =
      record !== undefined && erasureReplacements.delete(record);
    const retainedSource = retainedReplacement
      ? record
      : sameSource
        ? preMutationRecord
        : undefined;
    const sourceRich =
      retainedSource === undefined
        ? undefined
        : compiledStrokeCache.get(retainedSource);
    const sourcePacked =
      retainedSource === undefined
        ? undefined
        : packedCompiledForRecord(retainedSource);
    const sourceTranslation =
      retainedSource === undefined
        ? undefined
        : derivedTranslationOfRecord(retainedSource);
    const sourceJoint =
      retainedSource === undefined
        ? undefined
        : jointSourceByHead.get(retainedSource);
    if (preMutationRecord !== undefined)
      jointSourceByHead.delete(preMutationRecord);
    if (record !== undefined) jointSourceByHead.delete(record);
    if (sourceJoint !== undefined && record !== undefined) {
      const nextJoint = { ...sourceJoint };
      const rich = compiledStrokeCache.get(sourceJoint);
      const packed = packedCompiledForRecord(sourceJoint);
      if (rich !== undefined) compiledStrokeCache.set(nextJoint, rich);
      if (packed !== undefined) packedOnlyByRecord.set(nextJoint, packed);
      const offset = derivedTranslationOfRecord(sourceJoint);
      if (offset.tx !== 0 || offset.ty !== 0)
        derivedTranslationByRecord.set(nextJoint, offset);
      jointSourceByHead.set(record, nextJoint);
    }
    if (
      preMutationRecord !== undefined &&
      (record === undefined || record !== preMutationRecord)
    ) {
      try {
        const dropped = jointPackedByChunk.get(preMutationRecord as object);
        if (dropped !== undefined) droppedJoints.add(dropped as object);
      } catch {
        // Probing never breaks invalidation.
      }
      compiledStrokeCache.delete(preMutationRecord as object);
      compiledNullCache.delete(preMutationRecord as object);
      derivedTranslationByRecord.delete(preMutationRecord as object);
      packedCompiledByRecord.delete(preMutationRecord as object);
      packedOnlyByRecord.delete(preMutationRecord as object);
      jointPackedByChunk.delete(preMutationRecord as object);
    }
    if (record === undefined) {
      // Deleted record: bump the remembered logical (if any) so joint jobs
      // for that logical go stale; peers are cleared through the membership
      // index when any remain, and via the logical epoch when none remain.
      if (remembered !== null) affectedLogicals.add(remembered);
      if (previousLogical !== null) affectedLogicals.add(previousLogical);
      // Keep the remembered mapping (do not delete): a later recreation of
      // the same id still needs to know the old logical to bump it.
      state.preMutationRecordById.delete(id);
      continue;
    }
    try {
      const dropped = jointPackedByChunk.get(record as object);
      if (dropped !== undefined) droppedJoints.add(dropped as object);
    } catch {
      // Probing never breaks invalidation.
    }
    compiledStrokeCache.delete(record as object);
    compiledNullCache.delete(record as object);
    derivedTranslationByRecord.delete(record as object);
    packedCompiledByRecord.delete(record as object);
    packedOnlyByRecord.delete(record as object);
    jointPackedByChunk.delete(record as object);
    if (sourceRich !== undefined)
      compiledStrokeCache.set(record as object, sourceRich);
    if (sourcePacked !== undefined) {
      if (sourceRich !== undefined)
        packedCompiledByRecord.set(record as object, sourcePacked);
      else packedOnlyByRecord.set(record as object, sourcePacked);
    }
    if (
      sourceTranslation !== undefined &&
      (sourceTranslation.tx !== 0 || sourceTranslation.ty !== 0)
    ) {
      derivedTranslationByRecord.set(record as object, sourceTranslation);
    }
    try {
      const logical = logicalIdOf(record);
      if (logical !== null) {
        affectedLogicals.add(logical);
        addLogicalMember(state, record);
      }
      // Bump the old logical (index-recorded and/or pre-mutation captured)
      // when replacement changed membership (old logical ≠ new logical).
      if (previousLogical !== null && previousLogical !== logical) {
        affectedLogicals.add(previousLogical);
      }
      if (rememberedKnown && remembered !== null && remembered !== logical) {
        affectedLogicals.add(remembered);
        // Retain EVERY replaced-away old logical for the rendezvous survivor
        // path (multi-set: accumulate, never overwrite, so rapid
        // B:L→M→N keeps {L,M}). The ownership map below is overwritten with
        // the NEW logical so future mutations stay current. Covers L→M,
        // L→single / L→non-stroke (logical null), and L→non-stroke→M chains
        // (the second step keeps the earlier L via the set). Edge helpers
        // keep the reverse holder index in lockstep (idempotent via Set).
        addReplacedLogicalEdge(state, id, remembered);
      }
      // Return-to-old: the CURRENT logical is no longer historical for this
      // record (L→M→L retires L from this record's set, keeping M). Same-
      // logical edits (remembered === logical) add nothing above and retire
      // nothing here unless the current logical was pending from an earlier
      // chain — historiques from earlier replacements survive until the
      // explicit ack seam retires them after survivor success.
      if (logical !== null) {
        removeReplacedLogicalEdge(state, id, logical);
      }
      state.oldLogicalOwnershipByRecordId.set(id, logical);
      state.preMutationRecordById.set(id, record);
    } catch {
      // Logical clearing best-effort; single retention already cleared.
    }
  }
  // Geometry epochs for affected logicals: one bump per logical, covering
  // member edits, deletions, replacements, and creations that share the id.
  for (const logical of affectedLogicals) {
    try {
      bumpLogicalGeometryGeneration(state, logical);
    } catch {
      // Epoch bump never breaks invalidation.
    }
  }
  // Clear joint retention for all peers of affected logicals (one logical
  // behaves as one stroke: mutating any chunk invalidates the joint).
  // Uses the model-scoped membership index — O(mutated logical members),
  // never an O(document) object scan.
  if (affectedLogicals.size > 0) {
    try {
      const objects = modelObjects(model);
      for (const logical of affectedLogicals) {
        const members = state.logicalMembersById.get(logical);
        if (members === undefined) continue;
        for (const memberId of members) {
          const peer = objects[memberId];
          if (peer === undefined) continue;
          try {
            if (logicalIdOf(peer) !== logical) continue;
          } catch {
            continue;
          }
          try {
            const dropped = jointPackedByChunk.get(peer as object);
            if (dropped !== undefined) droppedJoints.add(dropped as object);
          } catch {
            // Probing never breaks invalidation.
          }
          jointPackedByChunk.delete(peer as object);
          if (changedLogicalSources.has(logical))
            jointSourceByHead.delete(peer);
          // Peers also drop per-record translation? No — per-record
          // geometry is chunk-local and dies with its own invalidation
          // above only for directly-mutated ids. Joint peers keep their
          // independent record translations (they still own that geometry).
        }
      }
    } catch {
      // Peer clearing never breaks invalidation.
    }
  }
  for (const joint of droppedJoints) {
    try {
      jointTranslationByPacked.delete(joint);
    } catch {
      // Never breaks invalidation.
    }
  }
}

/** Invalidate one detached record's local derived geometry. */
export function invalidateCompiledForRecord(record: SurfaceObjectRecord): void {
  jointSourceByHead.delete(record);
  // No model identity is available at this low-level seam, so it cannot
  // advance model-scoped epochs or clear logical peers. Model owners use
  // `invalidateCompiledForIds` for canonical mutations.
  try {
    const dropped = jointPackedByChunk.get(record as object);
    if (dropped !== undefined)
      jointTranslationByPacked.delete(dropped as object);
  } catch {
    // Probing never breaks invalidation.
  }
  compiledStrokeCache.delete(record as object);
  compiledNullCache.delete(record as object);
  derivedTranslationByRecord.delete(record as object);
  packedCompiledByRecord.delete(record as object);
  packedOnlyByRecord.delete(record as object);
  jointPackedByChunk.delete(record as object);
}

/**
 * Warm the compiled cache from async hydration (item 3): install
 * `compiled` (produced by `compileInkStrokeAsync`, bit-identical to sync)
 * so the next sync `compileRecord` hits without recompiling. For
 * background hydration of deferred huge strokes.
 *
 * `packed`, when supplied, retains the SAME packed representation the
 * Worker produced (or the lazy cache restored) so persistence can reuse
 * it instead of unpacking and repacking identical geometry.
 */
export function setCompiledForRecord(
  record: SurfaceObjectRecord,
  compiled: CompiledInkStroke | null,
  packed?: PackedCompiledInk,
): void {
  // Installed geometry is compiled from CURRENT canonical samples, so any
  // previously accumulated derived translation is consumed: reset to zero.
  derivedTranslationByRecord.delete(record as object);
  packedOnlyByRecord.delete(record as object);
  if (compiled === null) {
    compiledNullCache.add(record as object);
    compiledStrokeCache.delete(record as object);
    packedCompiledByRecord.delete(record as object);
  } else {
    compiledStrokeCache.set(record as object, compiled);
    compiledNullCache.delete(record as object);
    if (packed !== undefined) {
      packedCompiledByRecord.set(record as object, packed);
    } else {
      packedCompiledByRecord.delete(record as object);
    }
  }
}

/**
 * Retained packed compiled geometry for a record, when its installed
 * compiled geometry still corresponds to it (LOCAL coordinates; add the
 * derived translation for world). `undefined` when never packed/restored
 * or after invalidation/recompile. Falls back to packed-only retention
 * (packed-rendered records without rich geometry) so teardown can persist
 * packed draws without unpacking.
 */
export function packedCompiledForRecord(
  record: SurfaceObjectRecord,
): PackedCompiledInk | undefined {
  const retained = packedCompiledByRecord.get(record as object);
  if (retained !== undefined) {
    if (!compiledStrokeCache.has(record as object)) {
      // Stale rich retention without geometry (should not happen after
      // invalidation clears both, but guard anyway).
      return packedOnlyByRecord.get(record as object) ?? retained;
    }
    return retained;
  }
  return packedOnlyByRecord.get(record as object);
}

/** Drop only the retained packed copy (after ownership transfer). */
export function clearPackedCompiledForRecord(
  record: SurfaceObjectRecord,
): void {
  packedCompiledByRecord.delete(record as object);
  packedOnlyByRecord.delete(record as object);
}

/**
 * Retain a background-packed copy without resetting derived translation.
 * Used by the low-priority packing lane: live strokes compile synchronously
 * (rich) for immediate rendering, then a background task packs the same
 * geometry and retains it for future persistence. Only retains when compiled
 * geometry is still present; never touches translation (LOCAL coordinates).
 */
export function retainPackedForRecord(
  record: SurfaceObjectRecord,
  packed: PackedCompiledInk,
): void {
  if (!compiledStrokeCache.has(record as object)) return;
  packedCompiledByRecord.set(record as object, packed);
}

/**
 * Retain a packed-only copy for packed-rendered records (no rich geometry
 * installed, no B-spline compile, no unpack). LOCAL coordinates; persistence
 * rebases by the accumulated derived translation. Lets teardown persist
 * packed draws without ever expanding the object graph.
 */
export function retainPackedOnlyForRecord(
  record: SurfaceObjectRecord,
  packed: PackedCompiledInk,
): void {
  packedOnlyByRecord.set(record as object, packed);
}

/** Packed-only retention (packed renders without rich geometry). */
export function packedOnlyForRecord(
  record: SurfaceObjectRecord,
): PackedCompiledInk | undefined {
  return packedOnlyByRecord.get(record as object);
}

/** True when a record has any persistable packed copy (rich or packed-only). */
export function hasPersistablePacked(record: SurfaceObjectRecord): boolean {
  return (
    packedCompiledByRecord.has(record as object) ||
    packedOnlyByRecord.has(record as object)
  );
}

/**
 * Retain a joint packed result on every chunk of its logical stroke (same
 * reference, no duplication). Call after a joint logical compile (Worker
 * packed-direct or small sync pack) so teardown persists one stable joint
 * entry under the logical id. LOCAL coordinates; persistence rebases by the
 * JOINT translation (owned by the packed identity, not any chunk record).
 * Never touches translation (a fresh packed starts at 0; a reused packed
 * keeps its accumulated joint translation).
 */
export function retainJointPackedForChunks(
  chunks: readonly SurfaceObjectRecord[],
  packed: PackedCompiledInk,
): void {
  for (const chunk of chunks) {
    try {
      jointPackedByChunk.set(chunk as object, packed);
    } catch {
      // Retention never breaks preparation.
    }
  }
}

/** Joint packed retention for one chunk (same reference for all peers). */
export function jointPackedForChunk(
  record: SurfaceObjectRecord,
): PackedCompiledInk | undefined {
  return jointPackedByChunk.get(record as object);
}

/** True when a chunk carries joint packed retention for its logical stroke. */
export function hasJointPacked(record: SurfaceObjectRecord): boolean {
  return jointPackedByChunk.has(record as object);
}

/** Drop joint retention for explicit logical invalidation (member edit). */
export function clearJointPackedForChunks(
  chunks: readonly SurfaceObjectRecord[],
): void {
  const dropped = new Set<object>();
  for (const chunk of chunks) {
    try {
      const packed = jointPackedByChunk.get(chunk as object);
      if (packed !== undefined) dropped.add(packed as object);
      jointPackedByChunk.delete(chunk as object);
    } catch {
      // Ignore.
    }
  }
  for (const packed of dropped) {
    try {
      jointTranslationByPacked.delete(packed);
    } catch {
      // Ignore.
    }
  }
}

/**
 * Structural diagnostics for the translation path: `transformUpdates`
 * counts total derived-transform accumulations (joint + record, kept for
 * backward compatibility); `jointTransformUpdates` counts JOINT packed
 * updates (exactly once per translated logical with joint geometry);
 * `recordTransformUpdates` counts PER-RECORD updates (one per moved chunk
 * owning independent rich/packed geometry); `geometryCopies` counts
 * derived-geometry vertex copies performed by rigid translation — always
 * zero by construction (no translation path maps/copies nodes, polygon,
 * mesh, outline, or DrawItem points). The counter is a tripwire: any
 * future translation-time copy must increment it.
 */
export const derivedTranslationStats = {
  transformUpdates: 0,
  jointTransformUpdates: 0,
  recordTransformUpdates: 0,
  geometryCopies: 0,
};

/** Accumulated JOINT translation for a joint packed object (zero when absent). */
export function jointTranslationOfPacked(packed: PackedCompiledInk): {
  tx: number;
  ty: number;
} {
  const entry = jointTranslationByPacked.get(packed as object);
  if (entry === undefined) return { tx: 0, ty: 0 };
  return { tx: entry.tx, ty: entry.ty };
}

/**
 * Accumulated JOINT translation for a chunk's logical joint (zero when the
 * chunk carries no joint geometry). The translation belongs to the joint
 * packed identity, not to the chunk record.
 */
export function jointTranslationForChunk(record: SurfaceObjectRecord): {
  tx: number;
  ty: number;
} {
  const joint = jointPackedByChunk.get(record as object);
  if (joint === undefined) return { tx: 0, ty: 0 };
  return jointTranslationOfPacked(joint);
}

/** Accumulated derived translation for one record (zero when absent). */
export function derivedTranslationOfRecord(record: SurfaceObjectRecord): {
  tx: number;
  ty: number;
} {
  const entry = derivedTranslationByRecord.get(record as object);
  if (entry === undefined) return { tx: 0, ty: 0 };
  return { tx: entry.tx, ty: entry.ty };
}

/**
 * Rigid-translation preservation without geometry copies: accumulate
 * `(dx,dy)` onto derived-transform metadata instead of shifting cached
 * compiled vertices (the old `translateCompiledForIds` mapped every
 * node/polygon/mesh point).
 *
 * Call AFTER the canonical point rewrite (same ordering as the old path):
 * the cached geometry stays immutable in pre-translation local
 * coordinates and this metadata bridges to world coordinates.
 *
 * OWNERSHIP (FINAL correctness closure, §2): per-record and logical-joint
 * translations are SEPARATE owners.
 *
 * - per-record geometry (`compiledStrokeCache`, `packedCompiledByRecord`,
 *   `packedOnlyByRecord`) translates via `derivedTranslationByRecord`;
 * - logical-joint geometry (the single shared `PackedCompiledInk` retained
 *   on every chunk) translates via `jointTranslationByPacked`, exactly once
 *   per joint identity.
 *
 * A logical may own BOTH: joint packed + independent rich/packed geometry
 * on individual chunks. Translating the whole logical therefore:
 *   1. updates the JOINT transform once (if joint geometry exists);
 *   2. independently updates PER-RECORD translation for every moved chunk
 *      owning independent derived geometry;
 *   3. chunks with no independent record geometry need no per-record update.
 *
 * Examples (25k logical = 3 chunks):
 *   joint only → joint 1, records 0
 *   joint + warm B → joint 1, records 1
 *   joint + warm A/B/C → joint 1, records 3
 *
 * Records with no retained geometry skip: the next demand compile reads
 * the already-translated canonical samples directly, so recording there
 * would double-count. Returns total entries translated (joint + record;
 * O(derived owners), NEVER O(samples)). `geometryCopies` stays 0.
 *
 * Invariant preserved:
 *   world derived geometry = local immutable derived geometry
 *   + accumulated derived translation (per-owner)
 * (never duplicated onto canonical coordinates and derived transforms).
 */
export function accumulateDerivedTranslation(
  model: Pick<SurfaceModel, 'objects'>,
  ids: readonly string[],
  dx: number,
  dy: number,
): number {
  if (dx === 0 && dy === 0) return 0;
  const objects = (
    model as { objects: Record<string, SurfaceObjectRecord | undefined> }
  ).objects;
  // Background-pack position epoch: advance for every moved canonical id
  // (O(moved ids), never O(samples)/O(document)). Geometry generations
  // deliberately do NOT advance here — rigid translation preserves derived
  // geometry and must not trigger B-spline recompilation. The position
  // epoch exists ONLY to reject stale background/cold async work that
  // copied coordinates from a different canonical position.
  try {
    const positionState = geometryState(model);
    const seenPositionLogicals = new Set<string>();
    for (const id of ids) {
      const record = objects[id];
      if (record === undefined) continue;
      try {
        bumpRecordPositionGeneration(positionState, id);
      } catch {
        // Position bookkeeping never breaks translation.
      }
      try {
        const logical = logicalIdOf(record);
        if (logical !== null && !seenPositionLogicals.has(logical)) {
          seenPositionLogicals.add(logical);
          bumpLogicalPositionGeneration(positionState, logical);
        }
      } catch {
        // Logical probing never breaks translation.
      }
    }
  } catch {
    // Position bookkeeping never breaks translation.
  }
  // Group moved ids by logical ownership (O(moved ids), no full-model scan).
  // Key: logical id string for chunks, `null` bucket handled per-record.
  const logicalGroups = new Map<string, SurfaceObjectRecord[]>();
  const singles: SurfaceObjectRecord[] = [];
  for (const id of ids) {
    const record = objects[id];
    if (record === undefined) continue;
    if (compiledNullCache.has(record as object)) continue;
    let logical: string | null = null;
    try {
      logical = logicalIdOf(record);
    } catch {
      logical = null;
    }
    if (logical === null) {
      singles.push(record);
    } else {
      const list = logicalGroups.get(logical);
      if (list === undefined) logicalGroups.set(logical, [record]);
      else list.push(record);
    }
  }
  let jointUpdates = 0;
  let recordUpdates = 0;
  const accumulateRecord = (record: SurfaceObjectRecord): boolean => {
    const hasRich = compiledStrokeCache.has(record as object);
    const hasPacked =
      packedCompiledByRecord.has(record as object) ||
      packedOnlyByRecord.has(record as object);
    if (!hasRich && !hasPacked) return false;
    const entry = derivedTranslationByRecord.get(record as object);
    if (entry === undefined) {
      derivedTranslationByRecord.set(record as object, { tx: dx, ty: dy });
    } else {
      entry.tx += dx;
      entry.ty += dy;
    }
    recordUpdates += 1;
    return true;
  };
  // Singles: per-record only (singles never own joint geometry).
  for (const record of singles) {
    // Null entries already skipped above.
    const hasRich = compiledStrokeCache.has(record as object);
    const hasPacked =
      packedCompiledByRecord.has(record as object) ||
      packedOnlyByRecord.has(record as object);
    // Singles with joint retention cannot happen (joint only for logicals),
    // but handle defensively via joint path below if present.
    const hasJoint = jointPackedByChunk.has(record as object);
    if (!hasRich && !hasPacked && !hasJoint) continue;
    if (hasJoint && !hasRich && !hasPacked) {
      // Defensive: a single carrying joint retention (should not happen)
      // translates via the joint owner once.
      const joint = jointPackedByChunk.get(record as object);
      if (joint !== undefined) {
        const entry = jointTranslationByPacked.get(joint as object);
        if (entry === undefined) {
          jointTranslationByPacked.set(joint as object, { tx: dx, ty: dy });
        } else {
          entry.tx += dx;
          entry.ty += dy;
        }
        jointUpdates += 1;
        continue;
      }
    }
    if (accumulateRecord(record)) {
      // counted inside
    }
  }
  // Logical groups: joint once + per-record for each independently-warm chunk.
  for (const [, chunks] of logicalGroups) {
    // 1. JOINT transform exactly once, if joint geometry exists on any moved
    // peer. All peers share the SAME packed reference; pick the first
    // present. Callers translate whole logicals (expanded chunk ids), so the
    // joint is always among the moved set when it exists — no full-model
    // scan, translation stays O(moved chunks / derived owners).
    let joint: PackedCompiledInk | undefined;
    for (const chunk of chunks) {
      try {
        const candidate = jointPackedByChunk.get(chunk as object);
        if (candidate !== undefined) {
          joint = candidate;
          break;
        }
      } catch {
        // Probing never breaks translation.
      }
    }
    if (joint !== undefined) {
      const entry = jointTranslationByPacked.get(joint as object);
      if (entry === undefined) {
        jointTranslationByPacked.set(joint as object, { tx: dx, ty: dy });
      } else {
        entry.tx += dx;
        entry.ty += dy;
      }
      jointUpdates += 1;
    }
    // 2. PER-RECORD translation for every moved chunk owning independent
    // derived geometry (rich / record-packed / packed-only). Chunks with
    // only joint geometry need no per-record update.
    for (const chunk of chunks) {
      // The joint interaction wrapper shares source sample objects, but its
      // mask and local-geometry offset are snapshots. Carry those alongside
      // the canonical head without copying or recompiling source geometry.
      const source = jointSourceByHead.get(chunk);
      if (source !== undefined) {
        source.erasure = chunk.erasure;
        if (isCompiledWarm(source)) {
          const offset = derivedTranslationOfRecord(source);
          derivedTranslationByRecord.set(source, {
            tx: offset.tx + dx,
            ty: offset.ty + dy,
          });
        }
      }
      if (compiledNullCache.has(chunk as object)) continue;
      accumulateRecord(chunk);
    }
    // Note: if neither joint nor any per-record geometry exists, the next
    // joint/chunk compilation reads translated canonical directly (skip —
    // recording would double-count). No update counted.
  }
  const translated = jointUpdates + recordUpdates;
  derivedTranslationStats.transformUpdates += translated;
  derivedTranslationStats.jointTransformUpdates += jointUpdates;
  derivedTranslationStats.recordTransformUpdates += recordUpdates;
  // `compiledStrokeComputeStats.translates` keeps counting translation
  // preservations (now metadata accumulations, not vertex copies) so
  // existing structural gates keep their meaning: translations preserve
  // derived geometry without recompiling.
  compiledStrokeComputeStats.translates += translated;
  return translated;
}

/**
 * True when a record's compiled geometry is already cached (warm),
 * WITHOUT compiling on miss. Lets teardown persist viewport-prepared
 * vectors without paying B-spline compiles for cold records.
 *
 * Packed-only retention counts as warm: a packed-rendered record without
 * rich geometry is already prepared (packed committed rendering) and must
 * not be treated as cold (which would trigger restores/recompiles).
 */
export function isCompiledWarm(record: SurfaceObjectRecord): boolean {
  return (
    compiledStrokeCache.has(record as object) ||
    compiledNullCache.has(record as object) ||
    packedCompiledByRecord.has(record as object) ||
    packedOnlyByRecord.has(record as object)
  );
}

/** True when rich `CompiledInkStroke` geometry is installed (not packed-only). */
export function hasRichCompiledGeometry(record: SurfaceObjectRecord): boolean {
  return (
    compiledStrokeCache.has(record as object) ||
    compiledNullCache.has(record as object)
  );
}

/**
 * Peek the installed rich geometry without compiling on miss (background
 * packing validation). Returns the cached entry, null for empty strokes,
 * or undefined when cold (no geometry installed).
 */
export function peekCompiledForRecord(
  record: SurfaceObjectRecord,
): CompiledInkStroke | null | undefined {
  const cached = compiledStrokeCache.get(record as object);
  if (cached !== undefined) return cached;
  if (compiledNullCache.has(record as object)) return null;
  return undefined;
}

/**
 * Authoritative compiled geometry for one stroke record, shared by
 * rendering, bounds, hit-testing, selection, and erasing. Null when the
 * record carries no usable samples.
 *
 * Returned geometry is IMMUTABLE and in LOCAL geometry coordinates: it is
 * compiled once from canonical samples and never rewritten by
 * translation. Add `derivedTranslationOfRecord(record)` for world
 * coordinates (see `smoothSpineOfRecord`, the Ink `compile` outline, and
 * the prepared-scene transform).
 *
 * Packed-first materialization: when rich geometry is absent but a valid
 * packed result exists (cold Worker output / durable restore), the rich
 * object is rehydrated from the packed typed arrays via the validated
 * `unpackCompiledInk()` path — never recomputed from canonical samples
 * via `compileInkStroke`. One packed record materialized lazily costs one
 * rich unpack, zero B-spline compiles; unrelated packed records stay
 * packed. Translation is preserved (unpacked geometry is in the same
 * local/world base as the retained packed copy).
 */
export function compiledStrokeForRecord(
  record: SurfaceObjectRecord,
): CompiledInkStroke | null {
  const cached = compiledStrokeCache.get(record as object);
  if (cached !== undefined) return cached;
  if (compiledNullCache.has(record as object)) return null;
  // Packed-first: reuse validated packed geometry instead of rerunning the
  // B-spline/tessellation pipeline from canonical samples. Preserves the
  // accumulated derived translation (unpacked base matches retained base).
  const retained = packedCompiledForRecord(record);
  if (retained !== undefined) {
    try {
      const unpacked = unpackCompiledInk(retained);
      compiledStrokeCache.set(record as object, unpacked);
      compiledNullCache.delete(record as object);
      // Keep both retentions: rich for interaction, packed for persistence.
      // Translation untouched (world = unpacked base + translation).
      return unpacked;
    } catch {
      // Corrupt packed: fall through to canonical recompile (safe miss).
      // Drop the bad retention so it is never persisted.
      packedCompiledByRecord.delete(record as object);
      packedOnlyByRecord.delete(record as object);
    }
  }
  // Defensive: a fresh compile reads CURRENT canonical samples, which
  // already include any committed translation — so a stale accumulated
  // translation (only possible if recording ever precedes warming) is
  // consumed here rather than double-counted by world readers.
  derivedTranslationByRecord.delete(record as object);
  const samples = inkTypedSamplesOf(record);
  if (samples.length === 0) {
    compiledNullCache.add(record as object);
    packedCompiledByRecord.delete(record as object);
    packedOnlyByRecord.delete(record as object);
    return null;
  }
  const brush = resolveStrokeBrush(record);
  const compiled = compileInkStroke(samples, brush);
  compiledStrokeCache.set(record as object, compiled);
  // Fresh compile from canonical samples: any previously retained packed
  // copy predates this geometry and must never be persisted.
  packedCompiledByRecord.delete(record as object);
  packedOnlyByRecord.delete(record as object);
  compiledStrokeComputeStats.computes += 1;
  return compiled;
}

/**
 * Explicit lazy rich materialization from packed geometry (interaction
 * paths that genuinely require `CompiledInkStroke`).
 *
 * Uses the retained packed copy as the source via `unpackCompiledInk()`,
 * never `compileInkStroke()`. Returns the materialized rich geometry (or
 * null for empty strokes) and preserves world translation. Unrelated
 * packed records stay packed. `undefined` when the record holds no packed
 * geometry (caller should fall back to normal compilation).
 */
export function materializeRichFromPacked(
  record: SurfaceObjectRecord,
): CompiledInkStroke | null | undefined {
  if (compiledStrokeCache.has(record as object)) {
    return compiledStrokeCache.get(record as object) ?? null;
  }
  if (compiledNullCache.has(record as object)) return null;
  const retained = packedCompiledForRecord(record);
  if (retained === undefined) return undefined;
  try {
    const unpacked = unpackCompiledInk(retained);
    compiledStrokeCache.set(record as object, unpacked);
    return unpacked;
  } catch {
    packedCompiledByRecord.delete(record as object);
    packedOnlyByRecord.delete(record as object);
    return undefined;
  }
}

/**
 * Authoritative derived-geometry resolver for Ink interaction (FINAL §3).
 *
 * Consumers must NOT guess which WeakMap holds the geometry for a record.
 * Precedence:
 *   1. independent rich record geometry, if already present;
 *   2. independent packed / packed-only record geometry;
 *   3. logical joint packed geometry, if the record belongs to a logical
 *      stroke carrying a joint;
 *   4. only then cold canonical compilation.
 *
 * For packed joint geometry the translation belongs to the JOINT owner
 * (`jointTranslationByPacked`), not to the chunk record. Ordinary hit-test
 * / click / selection / lasso must use this resolver and must never rerun
 * the B-spline compiler merely because the record is a chunk.
 *
 * Do NOT install a whole logical stroke as a chunk's rich cache
 * (`setCompiledForRecord(chunk, wholeLogicalCompiled)`): that would lie
 * about ownership. Whole-logical rich materialization, when genuinely
 * required, must live under logical ownership (see
 * `materializeJointRichFromPacked`), never as a chunk's record geometry.
 */
export type InkInteractionGeometry =
  | {
      readonly kind: 'record-rich';
      readonly compiled: CompiledInkStroke;
      readonly tx: number;
      readonly ty: number;
    }
  | {
      readonly kind: 'record-packed';
      readonly packed: PackedCompiledInk;
      readonly tx: number;
      readonly ty: number;
    }
  | {
      readonly kind: 'logical-joint-packed';
      readonly packed: PackedCompiledInk;
      readonly tx: number;
      readonly ty: number;
      readonly logicalId: string;
    }
  | { readonly kind: 'cold' };

export function resolveInkInteractionGeometry(
  record: SurfaceObjectRecord,
): InkInteractionGeometry {
  try {
    const rich = compiledStrokeCache.get(record as object);
    if (rich !== undefined) {
      const { tx, ty } = derivedTranslationOfRecord(record);
      return { kind: 'record-rich', compiled: rich, tx, ty };
    }
    if (compiledNullCache.has(record as object)) return { kind: 'cold' };
    const packed = packedCompiledForRecord(record);
    if (packed !== undefined) {
      const { tx, ty } = derivedTranslationOfRecord(record);
      return { kind: 'record-packed', packed, tx, ty };
    }
    const joint = jointPackedByChunk.get(record as object);
    if (joint !== undefined) {
      let logicalId = '';
      try {
        logicalId = logicalIdOf(record) ?? '';
      } catch {
        logicalId = '';
      }
      const { tx, ty } = jointTranslationOfPacked(joint);
      return { kind: 'logical-joint-packed', packed: joint, tx, ty, logicalId };
    }
  } catch {
    // Probing never breaks interaction; fall through to cold.
  }
  return { kind: 'cold' };
}

/**
 * Ephemeral whole-logical rich geometry from the joint packed copy, under
 * LOGICAL ownership (FINAL §3.2). Unpacks the joint (one unpack, zero
 * B-spline) WITHOUT installing it as any chunk's `compiledStrokeCache`
 * entry. Returns undefined when the record carries no joint geometry.
 * Callers needing chunk-specific rich geometry must materialize that chunk
 * specifically; ordinary interaction must use the joint packed directly.
 */
export function materializeJointRichFromPacked(
  record: SurfaceObjectRecord,
): CompiledInkStroke | null | undefined {
  try {
    if (compiledStrokeCache.has(record as object)) {
      return compiledStrokeCache.get(record as object) ?? null;
    }
    const joint = jointPackedByChunk.get(record as object);
    if (joint === undefined) return undefined;
    const unpacked = unpackCompiledInk(joint);
    return unpacked;
  } catch {
    return undefined;
  }
}

/**
 * Smooth tessellated centerline of a stroke record: the same fitted curve
 * the renderer fills, as plain points. All spatial predicates
 * (hit-testing, lasso, eraser broad-phase, selection) measure against
 * this — never against the raw pointer polyline — so interaction matches
 * visible ink exactly.
 *
 * Packed-first: when rich geometry is absent but packed geometry exists,
 * the spine is read directly from `nodeXY` (+ derived translation) with
 * zero B-spline compiles and zero rich unpacks. Logical chunks with only
 * joint geometry read the JOINT spine (+ joint translation) with the same
 * guarantees — never compiling merely because the record is a chunk.
 * Only a genuinely missing geometry falls back to `compiledStrokeForRecord()`
 * (which itself reuses packed via unpack, never recompiling).
 */
// Joint source records are ephemeral. Erasure-only replacements reuse their
// source derivation; genuine source edits retire them at the generation seam.
const jointSourceByHead = new WeakMap<object, SurfaceObjectRecord>();

export function jointInkSourceRecord(
  group: LogicalStrokeGroup,
): SurfaceObjectRecord {
  const head = group.records[0]!;
  let joint = jointSourceByHead.get(head);
  if (joint === undefined) {
    joint = { ...head, id: group.logicalId, points: logicalSamples(group) };
    jointSourceByHead.set(head, joint);
  }
  const packed = jointPackedForChunk(head);
  if (packed !== undefined && !isCompiledWarm(joint)) {
    retainPackedOnlyForRecord(joint, packed);
    const offset = jointTranslationByPacked.get(packed);
    if (offset !== undefined)
      derivedTranslationByRecord.set(joint, { ...offset });
  }
  return joint;
}

/** Resolve a chunk through its complete source when erasure affects selection. */
export function inkInteractionRecord(
  model: Pick<SurfaceModel, 'objects'>,
  record: SurfaceObjectRecord,
): SurfaceObjectRecord {
  const logical = logicalIdOf(record);
  if (logical === null) return record;
  const records = logicalMembersOf(model, logical)
    .map((id) => model.objects[id]!)
    .filter(Boolean)
    .sort((a, b) => (chunkIndexOf(a) ?? 0) - (chunkIndexOf(b) ?? 0));
  if (records[0]?.erasure === undefined && rotationOf(record) === 0)
    return record;
  return jointInkSourceRecord({
    logicalId: logical,
    chunkIds: records.map((r) => r.id),
    records,
  });
}

const erasureReplacements = new WeakSet<SurfaceObjectRecord>();

/** Carry immutable source derivations between mask-only replacements in a batch. */
export function retainErasureSource(
  before: SurfaceObjectRecord,
  after: SurfaceObjectRecord,
): void {
  erasureReplacements.add(after);
  const rich = compiledStrokeCache.get(before);
  const packed = packedCompiledForRecord(before);
  if (rich !== undefined) compiledStrokeCache.set(after, rich);
  if (packed !== undefined) {
    if (rich !== undefined) packedCompiledByRecord.set(after, packed);
    else packedOnlyByRecord.set(after, packed);
  }
  const offset = derivedTranslationOfRecord(before);
  if (offset.tx !== 0 || offset.ty !== 0)
    derivedTranslationByRecord.set(after, { ...offset });
  const joint = jointSourceByHead.get(before);
  if (joint !== undefined) {
    const next = { ...joint, erasure: after.erasure };
    retainErasureSource(joint, next);
    jointSourceByHead.set(after, next);
  }
}

/** Original unrotated outline, in canonical (translated) coordinates. */
export function inkStrokeOutlineOfRecord(
  record: SurfaceObjectRecord,
): readonly Point[] {
  const packed = packedOutlineOfRecord(record);
  if (packed !== null) return packed;
  const compiled = compiledStrokeForRecord(record);
  if (compiled === null) return [];
  const { tx, ty } = derivedTranslationOfRecord(record);
  return tx === 0 && ty === 0
    ? compiled.polygon
    : compiled.polygon.map((p) => ({ x: p.x + tx, y: p.y + ty }));
}

/** Visible filled geometry; holes and disconnected pieces stay separate. */
export function inkStrokeContoursOfRecord(
  record: SurfaceObjectRecord,
): readonly (readonly Point[])[] {
  const region = inkRegion(record);
  return region !== null ? region.flat() : [inkStrokeOutlineOfRecord(record)];
}

export function smoothSpineOfRecord(record: SurfaceObjectRecord): Point[] {
  const resolved = resolveInkInteractionGeometry(record);
  if (resolved.kind === 'record-rich') {
    const { tx, ty } = resolved;
    const rich = resolved.compiled;
    if (tx === 0 && ty === 0)
      return rich.nodes.map((n) => ({ x: n.x, y: n.y }));
    return rich.nodes.map((n) => ({ x: n.x + tx, y: n.y + ty }));
  }
  if (
    resolved.kind === 'record-packed' ||
    resolved.kind === 'logical-joint-packed'
  ) {
    const packed = resolved.packed;
    const { tx, ty } = resolved;
    const out: Point[] = new Array(packed.nodeCount);
    for (let i = 0; i < packed.nodeCount; i++) {
      out[i] = {
        x: packed.nodeXY[i * 2]! + tx,
        y: packed.nodeXY[i * 2 + 1]! + ty,
      };
    }
    return out;
  }
  if (compiledNullCache.has(record as object)) return [];
  const compiled = compiledStrokeForRecord(record);
  if (compiled === null) return [];
  const { tx, ty } = derivedTranslationOfRecord(record);
  if (tx === 0 && ty === 0)
    return compiled.nodes.map((n) => ({ x: n.x, y: n.y }));
  return compiled.nodes.map((n) => ({ x: n.x + tx, y: n.y + ty }));
}

/**
 * Canonical samples along the smooth fitted centerline, for segment and
 * precision erasing. Splitting these (rather than the raw pointer
 * segments) is what makes eraser intersections correspond to the visible
 * derived geometry: on sparse input the fitted curve can sit well off the
 * raw chords, and cutting chords would erase invisible regions while
 * leaving visible ink. Positions and interpolated pressure/tilt/twist/dt
 * come from the curve; unknown members ride from the nearer control, and
 * taper/width re-derive on recompile (never stored). Falls back to the
 * stored samples when nothing compiled.
 *
 * Packed-first: reads node attributes directly from packed typed arrays
 * (+ translation) with zero B-spline compiles and zero rich unpacks when
 * rich geometry is absent.
 */
export function smoothSamplesOfRecord(
  record: SurfaceObjectRecord,
): InkSample[] {
  const resolved = resolveInkInteractionGeometry(record);
  if (resolved.kind === 'record-rich' && resolved.compiled.nodes.length > 0) {
    const rich = resolved.compiled;
    const { tx, ty } = resolved;
    return rich.nodes.map(
      (n) =>
        ({
          x: n.x + tx,
          y: n.y + ty,
          pressure: n.pressure,
          ...(n.tiltX !== null && n.tiltY !== null
            ? { tilt: { x: n.tiltX, y: n.tiltY } }
            : {}),
          ...(n.twist !== null ? { twist: n.twist } : {}),
          ...(n.dt !== null ? { dt: n.dt } : {}),
          ...n.extras,
        }) as InkSample,
    );
  }
  if (resolved.kind === 'record-rich') {
    return inkTypedSamplesOf(record);
  }
  if (compiledNullCache.has(record as object)) {
    return inkTypedSamplesOf(record);
  }
  if (
    resolved.kind === 'record-packed' ||
    resolved.kind === 'logical-joint-packed'
  ) {
    const packed = resolved.packed;
    if (packed.nodeCount === 0) return inkTypedSamplesOf(record);
    const { tx, ty } = resolved;
    const out: InkSample[] = new Array(packed.nodeCount);
    for (let i = 0; i < packed.nodeCount; i++) {
      const tiltX = packed.nodeTiltXY[i * 2]!;
      const tiltY = packed.nodeTiltXY[i * 2 + 1]!;
      const twist = packed.nodeTwist[i]!;
      const dt = packed.nodeDt[i]!;
      const sample: Record<string, unknown> = {
        x: packed.nodeXY[i * 2]! + tx,
        y: packed.nodeXY[i * 2 + 1]! + ty,
        pressure: packed.nodePressure[i]!,
        ...(Number.isFinite(tiltX) && Number.isFinite(tiltY)
          ? { tilt: { x: tiltX, y: tiltY } }
          : {}),
        ...(Number.isFinite(twist) ? { twist } : {}),
        ...(Number.isFinite(dt) ? { dt } : {}),
        ...(packed.nodeExtras?.[i] !== undefined
          ? { ...packed.nodeExtras[i] }
          : {}),
      };
      out[i] = sample as unknown as InkSample;
    }
    return out;
  }
  const compiled = compiledStrokeForRecord(record);
  if (compiled === null || compiled.nodes.length === 0) {
    return inkTypedSamplesOf(record);
  }
  const { tx, ty } = derivedTranslationOfRecord(record);
  return compiled.nodes.map(
    (n) =>
      ({
        x: n.x + tx,
        y: n.y + ty,
        pressure: n.pressure,
        ...(n.tiltX !== null && n.tiltY !== null
          ? { tilt: { x: n.tiltX, y: n.tiltY } }
          : {}),
        ...(n.twist !== null ? { twist: n.twist } : {}),
        ...(n.dt !== null ? { dt: n.dt } : {}),
        ...n.extras,
      }) as InkSample,
  );
}

/**
 * Conservative rendered half-width of a stroke record, derived from the
 * same resolved brush as the geometry compiler.
 * The compiler's per-node width is
 * `pressureWidth × taper × nib × tilt` with `nib ≤ 1` and `taper ≤ 1`,
 * so `size/2 × pressureMax × (1 + tiltEffect)` covers every rendered
 * pixel (outline offsets and round caps included). All interaction
 * geometry — bounds, hit-testing, selection, eraser envelopes — derives
 * from this one function, so rendered ink can never extend outside
 * culling/selection/hit areas.
 */
export function maxStrokeHalfWidth(record: SurfaceObjectRecord): number {
  const brush = resolveStrokeBrush(record);
  const pressureMax = brush.pressure.enabled
    ? Math.max(brush.pressure.maxFactor, 0)
    : 1;
  return Math.max((brush.size / 2) * pressureMax * (1 + brush.tiltEffect), 0);
}

/**
 * Authoritative compiled bounds of a stroke record: the AABB of the
 * actual brush outline polygon. `boundsOf` (the conservative envelope
 * above) always contains this for SINGLE records; tests pin the
 * containment. For logical chunks with only joint geometry, this returns
 * the JOINT bounds (whole-stroke extent) — the derived truth for
 * interaction — which intentionally exceeds the chunk-local envelope.
 * Callers that need the tight rendered extent (e.g. transform-handle
 * layout) use this; callers that need containment (culling, selection,
 * hit broad-phase) use `boundsOf`. Both derive from the same resolved
 * brush — never two incompatible width models.
 *
 * Packed-first: reads `boundsXYWH` directly (+ owning translation) with
 * zero B-spline compiles and zero rich unpacks when rich geometry is
 * absent, including joint-packed chunks.
 */
export function inkStrokeCompiledBounds(
  record: SurfaceObjectRecord,
): Bounds | null {
  const resolved = resolveInkInteractionGeometry(record);
  if (resolved.kind === 'record-rich') {
    const { tx, ty } = resolved;
    const rich = resolved.compiled;
    if (tx === 0 && ty === 0) return { ...rich.bounds };
    return { ...rich.bounds, x: rich.bounds.x + tx, y: rich.bounds.y + ty };
  }
  if (
    resolved.kind === 'record-packed' ||
    resolved.kind === 'logical-joint-packed'
  ) {
    const packed = resolved.packed;
    const { tx, ty } = resolved;
    return {
      x: packed.boundsXYWH[0]! + tx,
      y: packed.boundsXYWH[1]! + ty,
      width: packed.boundsXYWH[2]!,
      height: packed.boundsXYWH[3]!,
    };
  }
  const bounds = compiledStrokeForRecord(record)?.bounds ?? null;
  if (bounds === null) return null;
  const { tx, ty } = derivedTranslationOfRecord(record);
  if (tx === 0 && ty === 0) return { ...bounds };
  return { ...bounds, x: bounds.x + tx, y: bounds.y + ty };
}

const packedOutlines = new WeakMap<
  object,
  { tx: number; ty: number; points: Point[] }
>();

/**
 * Outline ring for a stroke record in world coordinates, read directly
 * from packed `polygonXY` (+ owning translation) when rich geometry is
 * absent — including logical chunks reading their JOINT outline.
 * Used by the Ink `compile` path to avoid a full rich unpack for outline
 * materialization. Returns null when neither rich nor packed/joint geometry
 * exists (caller falls back to normal compilation).
 */
export function packedOutlineOfRecord(
  record: SurfaceObjectRecord,
): Point[] | null {
  if (compiledStrokeCache.has(record as object)) return null;
  if (compiledNullCache.has(record as object)) return null;
  const resolved = resolveInkInteractionGeometry(record);
  if (
    resolved.kind !== 'record-packed' &&
    resolved.kind !== 'logical-joint-packed'
  ) {
    return null;
  }
  const packed = resolved.packed;
  const { tx, ty } = resolved;
  const cached = packedOutlines.get(packed);
  if (cached !== undefined && cached.tx === tx && cached.ty === ty)
    return cached.points;
  const out: Point[] = new Array(packed.polygonXY.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = {
      x: packed.polygonXY[i * 2]! + tx,
      y: packed.polygonXY[i * 2 + 1]! + ty,
    };
  }
  packedOutlines.set(packed, { tx, ty, points: out });
  return out;
}

/** AABB of samples expanded by half `pad` on every side. */
function inkSampleEnvelope(samples: readonly Point[], pad: number): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of samples) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  // Expand symmetrically so bounds cover the visible extent (culling,
  // selection chrome) while keeping the sample-bbox center as the
  // rotation pivot.
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}

/** Envelope of a stroke record for erasure radii and previews; null when unusable. */
export function inkStrokeEnvelope(record: SurfaceObjectRecord): Bounds | null {
  return inkStrokeBounds(record);
}

function lineWidthOf(record: SurfaceObjectRecord): number {
  const width = finiteNumber(record.width);
  return width !== null && width > 0 ? width : INK_DEFAULT_WIDTH;
}

function lineEndpoints(record: SurfaceObjectRecord): [Point, Point] | null {
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  const x2 = finiteNumber(record.x2);
  const y2 = finiteNumber(record.y2);
  return x === null || y === null || x2 === null || y2 === null
    ? null
    : [
        { x, y },
        { x: x2, y: y2 },
      ];
}

/** Routed polyline for a line record (straight passthrough included). */
function lineRoute(record: SurfaceObjectRecord): Point[] | null {
  const endpoints = lineEndpoints(record);
  if (endpoints === null) return null;
  const path = record.path;
  if (path !== 'orthogonal' && path !== 'curved') {
    return [endpoints[0]!, endpoints[1]!];
  }
  return routeConnector(endpoints[0]!, endpoints[1]!, path);
}

const lineObjectType: SurfaceObjectTypeDescriptor = {
  typeId: SURFACE_OBJECT_TYPES.line,
  version: 1,
  boundsOf: (record) => {
    const route = lineRoute(record);
    if (route === null) return null;
    const pad = lineWidthOf(record) / 2 + INK_HIT_TOLERANCE;
    const xs = route.map((p) => p.x);
    const ys = route.map((p) => p.y);
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    return {
      x: minX,
      y: minY,
      width: Math.max(...xs) + pad - minX,
      height: Math.max(...ys) + pad - minY,
    };
  },
  hitTest: (record, x, y) => {
    if (isLocked(record)) return false;
    const route = lineRoute(record);
    if (route === null) return false;
    const threshold = lineWidthOf(record) / 2 + INK_HIT_TOLERANCE;
    return pointPolylineDistance({ x, y }, route) <= threshold;
  },
  translate: (record, dx, dy) => {
    for (const key of ['x', 'x2'] as const) {
      if (typeof record[key] === 'number') {
        (record as Record<string, unknown>)[key] = (record[key] as number) + dx;
      }
    }
    for (const key of ['y', 'y2'] as const) {
      if (typeof record[key] === 'number') {
        (record as Record<string, unknown>)[key] = (record[key] as number) + dy;
      }
    }
  },
  compile: (record) => {
    const endpoints = lineEndpoints(record);
    if (endpoints === null) return null;
    const path =
      record.path === 'orthogonal' || record.path === 'curved'
        ? record.path
        : undefined;
    // Routed paths render their computed polyline; bounds cover the
    // full route (curves bulge past the endpoint box).
    const route =
      path === undefined
        ? endpoints
        : routeConnector(endpoints[0]!, endpoints[1]!, path);
    const bounds = (() => {
      const pad = lineWidthOf(record) / 2 + INK_HIT_TOLERANCE;
      const xs = route.map((p) => p.x);
      const ys = route.map((p) => p.y);
      const minX = Math.min(...xs) - pad;
      const minY = Math.min(...ys) - pad;
      return {
        x: minX,
        y: minY,
        width: Math.max(...xs) + pad - minX,
        height: Math.max(...ys) + pad - minY,
      };
    })();
    const color = typeof record.color === 'string' ? record.color : undefined;
    const opacity = finiteNumber(record.opacity);
    return {
      kind: 'line',
      objectId: record.id,
      bounds,
      rotation: 0,
      x: endpoints[0]!.x,
      y: endpoints[0]!.y,
      x2: endpoints[1]!.x,
      y2: endpoints[1]!.y,
      width: lineWidthOf(record),
      ...(color !== undefined ? { color } : {}),
      ...(opacity !== null ? { opacity } : {}),
      ...(isLineArrows(record.arrows) ? { arrows: record.arrows } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(path !== undefined ? { points: route } : {}),
    };
  },
};

const inkStrokeObjectType: SurfaceObjectTypeDescriptor = {
  typeId: SURFACE_OBJECT_TYPES.stroke,
  version: 1,
  boundsOf: inkStrokeBounds,
  hitTest: (record, x, y) => {
    if (isLocked(record)) return false;
    const bounds = inkStrokeBounds(record);
    if (bounds === null) return false;
    // Same pivot contract as the sized types: rotate the query into the
    // stroke's local frame around its bounding-box center. The threshold
    // is the conservative rendered half-width (same brush derivation as
    // bounds), so hit-testing covers the actual brush outline — pressure
    // swell, tilt widening, and flat-nib direction included. Distance is
    // measured to the smooth tessellated centerline (the visible curve),
    // never to the raw pointer polyline.
    const local = unrotateAround(
      { x, y },
      centerOfBounds(bounds),
      rotationOf(record),
    );
    const threshold = maxStrokeHalfWidth(record) + INK_HIT_TOLERANCE;
    // Exact broad phase: every smooth-spine node lies within the raw
    // sample bbox (resampling interpolates, stabilization/fairing are
    // convex blends, the B-spline stays in its control hull), which
    // `bounds` covers plus a half-width pad — so a query outside
    // bounds⊕threshold cannot be within threshold of the spine. Skips
    // spine compilation entirely for non-containing queries with
    // bit-identical results.
    if (
      local.x < bounds.x - threshold ||
      local.x > bounds.x + bounds.width + threshold ||
      local.y < bounds.y - threshold ||
      local.y > bounds.y + bounds.height + threshold
    ) {
      return false;
    }
    return record.sourceId === undefined
      ? pointPolylineDistance(local, smoothSpineOfRecord(record)) <= threshold
      : hitVisible(inkStrokeContoursOfRecord(record), local, INK_HIT_TOLERANCE);
  },
  translate: (record, dx, dy) => {
    if (record.sourceId !== undefined) {
      mapInkRegion(record, (p) => ({ x: p.x + dx, y: p.y + dy }));
      return;
    }

    // Strokes carry no stored envelope: translation moves every sample.
    for (const raw of record.points as unknown[]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const s = raw as Record<string, unknown>;
      if (typeof s.x === 'number') s.x += dx;
      if (typeof s.y === 'number') s.y += dy;
    }
  },
  resize: (record, size) => {
    if (record.sourceId !== undefined) {
      const bounds = inkStrokeBounds(record);
      if (bounds === null) return false;
      const center = centerOfBounds(bounds);
      const fx =
        size.width === undefined || bounds.width === 0
          ? 1
          : size.width / bounds.width;
      const fy =
        size.height === undefined || bounds.height === 0
          ? 1
          : size.height / bounds.height;
      mapInkRegion(record, (p) => ({
        x: center.x + (p.x - center.x) * fx,
        y: center.y + (p.y - center.y) * fy,
      }));
      return fx !== 1 || fy !== 1;
    }
    // Geometric resize scales samples about the sample-bbox center
    // (thickness stays in the width style member, set via style verbs).
    const points = record.points;
    if (!Array.isArray(points)) return false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const raw of points) {
      if (typeof raw !== 'object' || raw === null) continue;
      const s = raw as Record<string, unknown>;
      if (typeof s.x !== 'number' || typeof s.y !== 'number') continue;
      minX = Math.min(minX, s.x);
      minY = Math.min(minY, s.y);
      maxX = Math.max(maxX, s.x);
      maxY = Math.max(maxY, s.y);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return false;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const fx =
      size.width !== undefined && maxX - minX > 0
        ? size.width / (maxX - minX)
        : 1;
    const fy =
      size.height !== undefined && maxY - minY > 0
        ? size.height / (maxY - minY)
        : 1;
    if (fx === 1 && fy === 1) return false;
    for (const raw of points) {
      if (typeof raw !== 'object' || raw === null) continue;
      const s = raw as Record<string, unknown>;
      if (typeof s.x !== 'number' || typeof s.y !== 'number') continue;
      s.x = centerX + (s.x - centerX) * fx;
      s.y = centerY + (s.y - centerY) * fy;
    }

    return true;
  },
  compile: (record) => {
    const bounds = inkStrokeBounds(record);
    if (bounds === null) return null;
    const color = typeof record.color === 'string' ? record.color : undefined;
    const opacity = finiteNumber(record.opacity);
    if (record.sourceId !== undefined)
      return {
        kind: 'stroke',
        objectId: record.id,
        bounds,
        rotation: rotationOf(record),
        points: [],
        width: inkWidthOf(record),
        color,
        opacity: opacity ?? 1,
        outline: [],
        contours: inkStrokeContoursOfRecord(record),
      };
    const typedSamples = inkTypedSamplesOf(record);
    // One authoritative smooth-stroke path: the shared derived cache
    // compiles once per canonical change no matter how many of rendering,
    // culling, hit-testing, or selection ask. Non-empty strokes always
    // carry a closed outline ring (dots stamp filled nib discs).
    //
    // The cached polygon is immutable LOCAL geometry; the outline emitted
    // here is world geometry (canonical `bounds`/`points` above already
    // are), so the accumulated derived translation is applied while
    // materializing this fresh item. Translation commits never rebuild
    // items — they only bump prepared transforms (see PreparedItem).
    //
    // Packed-first: when rich geometry is absent but packed exists, read
    // the outline directly from `polygonXY` (+ translation) with zero
    // B-spline compiles and zero rich unpacks. Rich materialization (via
    // `compiledStrokeForRecord`) is reserved for callers that genuinely
    // need the full `CompiledInkStroke`.
    const packedOutline = packedOutlineOfRecord(record);
    const cachedPolygon =
      packedOutline ?? compiledStrokeForRecord(record)?.polygon ?? [];
    const { tx, ty } = derivedTranslationOfRecord(record);
    // `packedOutlineOfRecord` already includes translation; rich polygon
    // needs it applied here.
    const outline =
      packedOutline !== null
        ? packedOutline
        : tx === 0 && ty === 0
          ? [...cachedPolygon]
          : cachedPolygon.map((p) => ({ x: p.x + tx, y: p.y + ty }));
    return {
      kind: 'stroke',
      objectId: record.id,
      bounds,
      rotation: rotationOf(record),
      points: typedSamples,
      width: inkWidthOf(record),
      ...(color !== undefined ? { color } : {}),
      ...(opacity !== null ? { opacity } : {}),
      outline,
    };
  },
};

const cardObjectType: SurfaceObjectTypeDescriptor = {
  typeId: SURFACE_OBJECT_TYPES.card,
  version: 1,
  boundsOf: sizedBounds,
  connectorAnchor: (record, anchor) =>
    sizedConnectorAnchor(record, anchor, sizedBounds),
  hitTest: (record, x, y) => {
    if (isLocked(record)) return false;
    const bounds = sizedBounds(record);
    return (
      bounds !== null &&
      pointInRotatedBounds(bounds, rotationOf(record), { x, y })
    );
  },
  compile: (record) => {
    const bounds = sizedBounds(record);
    if (bounds === null || typeof record.text !== 'string') return null;
    const fill = typeof record.fill === 'string' ? record.fill : undefined;
    const stroke =
      typeof record.stroke === 'string' ? record.stroke : undefined;
    const color = typeof record.color === 'string' ? record.color : undefined;
    const size = finiteNumber(record.size) ?? 14;
    return {
      kind: 'card',
      objectId: record.id,
      bounds,
      rotation: rotationOf(record),
      text: record.text,
      size,
      ...(color !== undefined ? { color } : {}),
      ...(fill !== undefined ? { fill } : {}),
      ...(stroke !== undefined ? { stroke } : {}),
    };
  },
};

const resourceEmbedObjectType: SurfaceObjectTypeDescriptor = {
  typeId: SURFACE_OBJECT_TYPES.resourceEmbed,
  version: 1,
  boundsOf: sizedBounds,
  hitTest: (record, x, y) => {
    if (isLocked(record)) return false;
    const bounds = sizedBounds(record);
    return (
      bounds !== null &&
      pointInRotatedBounds(bounds, rotationOf(record), { x, y })
    );
  },
  compile: (record) => {
    const bounds = sizedBounds(record);
    if (bounds === null) return null;
    const target = record.target;
    if (typeof target !== 'object' || target === null) return null;
    const t = target as Record<string, unknown>;
    if (
      typeof t.documentId !== 'string' ||
      typeof t.kindId !== 'string' ||
      typeof t.resourceId !== 'string'
    )
      return null;
    return {
      kind: 'resource-embed',
      objectId: record.id,
      bounds,
      rotation: rotationOf(record),
      target: {
        documentId: t.documentId,
        kindId: t.kindId,
        resourceId: t.resourceId,
        ...(typeof t.address === 'string' ? { address: t.address } : {}),
      },
      ...(typeof record.cachedTitle === 'string'
        ? { cachedTitle: record.cachedTitle }
        : {}),
    };
  },
};

/** Registry holding exactly the core object types (shapes, text, image, ink). */
export function createDefaultSurfaceObjectTypeRegistry(
  options: { measureText?: SurfaceTextMeasure } = {},
): SurfaceObjectTypeRegistry {
  const registry = new InMemorySurfaceObjectTypeRegistry();
  const boundsOf = (record: SurfaceObjectRecord) =>
    textBounds(record, options.measureText);
  const measuredText: SurfaceObjectTypeDescriptor =
    options.measureText === undefined
      ? textObjectType
      : {
          ...textObjectType,
          boundsOf,
          connectorAnchor: (record, anchor) =>
            sizedConnectorAnchor(record, anchor, boundsOf),
          hitTest: (record, x, y) => {
            const bounds = boundsOf(record);
            return (
              !isLocked(record) &&
              bounds !== null &&
              pointInRotatedBounds(bounds, rotationOf(record), { x, y })
            );
          },
          compile: (record) => {
            const item = textObjectType.compile?.(record);
            const bounds = boundsOf(record);
            return item != null && !Array.isArray(item) && bounds !== null
              ? { ...item, bounds }
              : null;
          },
        };
  for (const descriptor of [
    rectangleObjectType,
    ellipseObjectType,
    measuredText,
    imageObjectType,
    inkStrokeObjectType,
    lineObjectType,
    cardObjectType,
    resourceEmbedObjectType,
    groupObjectType,
  ]) {
    registry.register(descriptor);
  }
  return registry;
}

/**
 * Flat member group (slice 9): organizational record, paints nothing.
 * The descriptor compiles to zero items (never a placeholder box) and
 * reports no bounds or hits — group awareness lives in the controller,
 * which promotes member hits/selections and expands verbs to members.
 */
const groupObjectType: SurfaceObjectTypeDescriptor = {
  typeId: SURFACE_OBJECT_TYPES.group,
  version: 1,
  boundsOf: () => null,
  hitTest: () => false,
  compile: () => [],
};

/** Existing member ids of a group record, in stored order. */
export function groupMembersOf(
  model: {
    objects: Record<string, { type?: unknown; children?: unknown } | undefined>;
  },
  groupId: string,
): string[] {
  const record = model.objects[groupId];
  if (record?.type !== SURFACE_OBJECT_TYPES.group) return [];
  const children = (record as { children?: unknown }).children;
  if (!Array.isArray(children)) return [];
  return children.filter(
    (child): child is string =>
      typeof child === 'string' &&
      child !== groupId &&
      model.objects[child] !== undefined,
  );
}

/**
 * First group (paint order) containing a member, for hit promotion.
 * Unknown ids and groups themselves resolve to null.
 */
export function groupOfMember(
  model: {
    order: readonly string[];
    objects: Record<string, { type?: unknown; children?: unknown } | undefined>;
  },
  memberId: string,
): string | null {
  for (const id of model.order) {
    if (id === memberId) continue;
    const record = model.objects[id];
    if (record?.type !== SURFACE_OBJECT_TYPES.group) continue;
    const children = (record as { children?: unknown }).children;
    if (Array.isArray(children) && children.includes(memberId)) return id;
  }
  return null;
}

/**
 * Expand group ids to their existing members (paint-ordered, deduped);
 * non-group ids pass through. Flat group semantics: nested group ids in a
 * member list pass through untouched.
 *
 * Logical-stroke chunks expand identically: any chunk id of a multi-chunk
 * logical stroke expands to every chunk id of that stroke (head first),
 * so move/select/delete/lock/duplicate treat chunks as one logical
 * stroke. Eraser fragments carry no chunk identity (deliberate split).
 */
export function resolveGroupMembers(
  model: {
    order: readonly string[];
    objects: Record<string, { type?: unknown; children?: unknown } | undefined>;
  },
  ids: readonly string[],
): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (model.objects[id] === undefined || seen.has(id)) return;
    seen.add(id);
    expanded.push(id);
  };
  for (const id of ids) {
    const record = model.objects[id];
    if (record?.type === SURFACE_OBJECT_TYPES.group) {
      for (const member of groupMembersOf(model, id)) push(member);
    } else {
      push(id);
    }
  }
  // Logical-stroke expansion (one logical stroke behaves as one selection
  // identity across all verbs).
  const withLogical = expandLogicalIds(
    model as unknown as Parameters<typeof expandLogicalIds>[0],
    expanded,
  );
  // Paint-order the result for deterministic verb application.
  const rank = new Map(model.order.map((id, i) => [id, i] as const));
  return withLogical
    .filter((id) => model.objects[id] !== undefined)
    .sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
}
