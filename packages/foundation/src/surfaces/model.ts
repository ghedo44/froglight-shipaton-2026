/**
 * Canonical surface model.
 *
 * Preservation-first: object and frame records are kept as parsed JSON
 * records so unknown fields survive byte-stable round trips. Typed
 * constructors emit canonical field order; validators give codec,
 * registry, and interaction code a shared headless notion of "valid".
 * Host- and renderer-free: no DOM, Canvas, or editor types.
 */

import {
  isResourceTarget,
  isUnsafeAssetSrc,
  isValidNamespacedTypeId,
} from '../blocks/model.js';
import {
  INK_SOURCE_TYPE,
  validInkRegionRecord,
} from './ink/fragment-validation.js';
import { INK_BRUSH_KINDS, type InkBrushKind } from './ink/brush.js';

export type JsonAtom = null | boolean | number | string;
export type JsonValue =
  | JsonAtom
  | { [key: string]: JsonValue }
  | readonly JsonValue[];
export type JsonRecord = { [key: string]: JsonValue };

/**
 * Surface object identifier. Opaque non-empty string, unique per surface,
 * stable for the life of the object (spec §3) so future document
 * locations can target it. Validity is structural, like block ids.
 */
export type SurfaceObjectId = string;

/** Core object type ids (namespace `froglight.*` per spec §6). */
export const SURFACE_OBJECT_TYPES = {
  rectangle: 'froglight.rectangle',
  ellipse: 'froglight.ellipse',
  text: 'froglight.text',
  image: 'froglight.image',
  stroke: 'froglight.ink.stroke',
  inkSource: INK_SOURCE_TYPE,
  line: 'froglight.line',
  card: 'froglight.card',
  resourceEmbed: 'froglight.resource-embed',
  group: 'froglight.group',
} as const;

export type CoreSurfaceObjectType =
  (typeof SURFACE_OBJECT_TYPES)[keyof typeof SURFACE_OBJECT_TYPES];

const CORE_TYPE_ID_SET: ReadonlySet<string> = new Set(
  Object.values(SURFACE_OBJECT_TYPES),
);

/** True when `type` names a spec §5 core object type. */
export function isCoreSurfaceObjectType(
  type: unknown,
): type is CoreSurfaceObjectType {
  return typeof type === 'string' && CORE_TYPE_ID_SET.has(type);
}

export { isValidNamespacedTypeId };

// --- Frames ---

export interface BoundedFrame {
  readonly kind: 'bounded';
  readonly width: number;
  readonly height: number;
}

export interface InfiniteFrame {
  readonly kind: 'infinite';
}

/**
 * Frame record as stored in the payload: kept verbatim when valid.
 * Unknown members inside a structurally valid frame survive round trips.
 */
export type SurfaceFrame = JsonRecord;

export function boundedFrame(width: number, height: number): SurfaceFrame {
  return { kind: 'bounded', width, height };
}

export function infiniteFrame(): SurfaceFrame {
  return { kind: 'infinite' };
}

/** Width/height of a bounded frame; null for infinite or invalid frames. */
export function frameBounds(
  frame: unknown,
): { width: number; height: number } | null {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame))
    return null;
  const record = frame as JsonRecord;
  if (record.kind === 'infinite') return null;
  if (
    record.kind === 'bounded' &&
    typeof record.width === 'number' &&
    typeof record.height === 'number'
  ) {
    return { width: record.width, height: record.height };
  }
  return null;
}

// --- Objects ---

/** Raw object record: `{id, type}` plus arbitrary envelope fields. */
export interface SurfaceObjectRecord {
  readonly id: SurfaceObjectId;
  readonly type: string;
  [key: string]: unknown;
}

/** Canonical surface model. Plain/mutable so editor adapters update in place. */
export interface SurfaceModel {
  formatVersion: 1;
  frame: SurfaceFrame;
  order: SurfaceObjectId[];
  objects: Record<SurfaceObjectId, SurfaceObjectRecord>;
  /**
   * Unknown payload-level members captured at decode (spec §3/§7),
   * re-emitted after the known members on encode — the manifest
   * `unknownFields` precedent.
   */
  unknownFields?: Record<string, JsonValue>;
}

export type RectangleShape = 'rectangle' | 'rounded' | 'diamond' | 'triangle';

export interface RectangleGeometry {
  cornerRadius?: number;
  shape?: RectangleShape;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

export interface TextGeometry {
  x: number;
  y: number;
  text: string;
  rotation?: number;
  size?: number;
  color?: string;
  /**
   * Additive Surface text: semantic role.
   * Absent means `"body"`. Unknown wire strings render as `"body"` but
   * round-trip verbatim (never normalized on write, never a warning —
   * the record stays a valid core object). No `formatVersion` bump
   * (same precedent as `dt`/`brush`/`locked`).
   */
  role?: TextRole;
  /**
   * Additive Surface text layout: alignment + soft-wrap width.
   * Absent means start-aligned, unbounded (current behavior). Malformed
   * members degrade to defaults layout-only; the object stays valid and
   * bytes are preserved verbatim (never a hard error, never a warning).
   */
  appearance?: TextAppearance;
}

/**
 * Surface text role. Absent = `"body"`. Unknown strings
 * render as `"body"` and round-trip verbatim.
 */
export type TextRole = 'body' | 'heading' | 'caption' | 'label';

/** Known Surface text roles (wire may carry unknown strings — see `textRoleOf`). */
export const TEXT_ROLES: readonly TextRole[] = [
  'body',
  'heading',
  'caption',
  'label',
] as const;

/**
 * Surface text horizontal alignment inside `[x, x + boxWidth]`.
 * Absent = `"start"`. Unknown strings fall back to `"start"`
 * for layout and round-trip verbatim. Align MUST NOT move the `(x, y)`
 * origin or resize the envelope.
 */
export type TextAlign = 'start' | 'center' | 'end';

/** Known Surface text alignments. */
export const TEXT_ALIGNS: readonly TextAlign[] = [
  'start',
  'center',
  'end',
] as const;

/**
 * Surface text appearance: all members optional and additive.
 * `wrapWidth` is valid only when finite, `> 0`, and within
 * `SURFACE_MAX_COORDINATE`; otherwise it is ignored layout-only
 * (object stays valid, bytes preserved verbatim, no warning, no hard
 * error — `findGeometryLimitViolation` deliberately excludes it).
 * `bold`/`italic` are additive traits: exactly `true` reads active,
 * anything else reads inactive (never a throw, never normalization).
 * `size` (when valid: finite, `> 0`, within cap) overrides the record
 * `size` for the H1/H2 split and effective rendering; invalid
 * values degrade to the record size. Unknown appearance members round-trip
 * verbatim — writers merge, never replace, the appearance object.
 */
export interface TextAppearance {
  align?: TextAlign;
  wrapWidth?: number;
  bold?: boolean;
  italic?: boolean;
  size?: number;
}

/** Default font size in surface units when `size` is absent/invalid.*/
export const TEXT_DEFAULT_SIZE = 16;
/**
 * Default soft-wrap width applied by wrap-on when the record carries no
 * valid `wrapWidth`. Fixed, never measured (never feed
 * measured widths into canonical). Matches the t3 caption fixture width.
 */
export const TEXT_DEFAULT_WRAP_WIDTH = 240;
/** Nominal per-line height factor: `1.25 × effectiveSize` (contracts §1.2). */
export const TEXT_LINE_HEIGHT_FACTOR = 1.25;
/** Headless average glyph advance: `0.6em` (existing `textEstBounds`). */
export const TEXT_AVG_ADVANCE_FACTOR = 0.6;

/** True for the four known Surface text roles. */
export function isKnownTextRole(value: unknown): value is TextRole {
  return (
    value === 'body' ||
    value === 'heading' ||
    value === 'caption' ||
    value === 'label'
  );
}

/** True for the three known Surface text alignments. */
export function isKnownTextAlign(value: unknown): value is TextAlign {
  return value === 'start' || value === 'center' || value === 'end';
}

/**
 * Effective Surface text role for rendering (.. companion): known roles
 * pass through, absent/unknown render as `"body"`. The wire value is
 * never normalized — verbatim preservation stays in the record.
 */
export function textRoleOf(
  record: SurfaceObjectRecord | { readonly role?: unknown },
): TextRole {
  const role = (record as { readonly role?: unknown }).role;
  return isKnownTextRole(role) ? role : 'body';
}

/**
 * Effective Surface text alignment for layout: known values pass through,
 * absent/unknown fall back to `"start"`. Envelope-invariant (see
 * `textV2EstBounds`).
 */
export function textAlignOf(
  record: SurfaceObjectRecord | { readonly appearance?: unknown },
): TextAlign {
  const appearance = (record as { readonly appearance?: unknown }).appearance;
  if (
    typeof appearance === 'object' &&
    appearance !== null &&
    !Array.isArray(appearance)
  ) {
    const align = (appearance as Record<string, unknown>).align;
    if (isKnownTextAlign(align)) return align;
  }
  return 'start';
}

/** True when `wrapWidth` is usable for layout (finite, > 0, within cap). */
export function isValidWrapWidth(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= SURFACE_MAX_COORDINATE
  );
}

/**
 * Effective Surface text wrap width for layout: the valid number, else `null`
 * for unbounded (current behavior). Invalid values (wrong type,
 * non-finite, `<= 0`, over-cap) degrade layout-only — the record stays
 * valid, bytes preserved verbatim, NO warning (contracts §1.2 rules 2+6)
 * and NO hard error (`geometryNumbersOf` excludes `appearance`).
 */
export function textWrapWidthOf(
  record: SurfaceObjectRecord | { readonly appearance?: unknown },
): number | null {
  const appearance = (record as { readonly appearance?: unknown }).appearance;
  if (
    typeof appearance === 'object' &&
    appearance !== null &&
    !Array.isArray(appearance)
  ) {
    const wrapWidth = (appearance as Record<string, unknown>).wrapWidth;
    if (isValidWrapWidth(wrapWidth)) return wrapWidth;
  }
  return null;
}

/**
 * Effective font size for Surface text bounds/draw (resolution): `size`
 * when it is a finite number `> 0` within the coordinate cap, else
 * `TEXT_DEFAULT_SIZE` (16 — the existing `textEstBounds`/compile
 * fallback, so legacy single-line bounds are unchanged).
 */
export function effectiveTextSizeOf(
  record: SurfaceObjectRecord | { readonly size?: unknown },
): number {
  const size = (record as { readonly size?: unknown }).size;
  if (
    typeof size === 'number' &&
    Number.isFinite(size) &&
    size > 0 &&
    size <= SURFACE_MAX_COORDINATE
  ) {
    return size;
  }
  return TEXT_DEFAULT_SIZE;
}

/**
 * Additive bold trait: exactly `true` in `appearance`
 * reads active, anything else (absent, false, non-boolean) reads inactive.
 * Never throws, never normalizes the record.
 */
export function textBoldOf(
  record: SurfaceObjectRecord | { readonly appearance?: unknown },
): boolean {
  const appearance = (record as { readonly appearance?: unknown }).appearance;
  if (
    typeof appearance === 'object' &&
    appearance !== null &&
    !Array.isArray(appearance)
  ) {
    return (appearance as Record<string, unknown>).bold === true;
  }
  return false;
}

/**
 * Additive italic trait: exactly `true` in `appearance`
 * reads active, anything else reads inactive. Never throws.
 */
export function textItalicOf(
  record: SurfaceObjectRecord | { readonly appearance?: unknown },
): boolean {
  const appearance = (record as { readonly appearance?: unknown }).appearance;
  if (
    typeof appearance === 'object' &&
    appearance !== null &&
    !Array.isArray(appearance)
  ) {
    return (appearance as Record<string, unknown>).italic === true;
  }
  return false;
}

/** True when `appearance.size` is usable (finite, > 0, within cap). */
export function isValidAppearanceSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= SURFACE_MAX_COORDINATE
  );
}

/**
 * Effective surface-text size (H1/H2 split): `appearance.size`
 * when valid, else the record `size` via `effectiveTextSizeOf`, else
 * `TEXT_DEFAULT_SIZE`. Read-only — never writes, never normalizes.
 * Matches the notebook `deriveSurfaceTextSelectionState` preview so
 * selection, bounds, compile, overlay, and canvas agree.
 */
export function effectiveSurfaceTextSizeOf(
  record:
    | SurfaceObjectRecord
    | { readonly size?: unknown; readonly appearance?: unknown },
): number {
  const appearance = (record as { readonly appearance?: unknown }).appearance;
  if (
    typeof appearance === 'object' &&
    appearance !== null &&
    !Array.isArray(appearance)
  ) {
    const size = (appearance as Record<string, unknown>).size;
    if (isValidAppearanceSize(size)) return size;
  }
  return effectiveTextSizeOf(record);
}

export interface ImageGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  src: string;
  sha256: string;
  rotation?: number;
}

/** One captured ink sample. Hardware axes are optional and stored verbatim. */
export interface InkTilt {
  /** Per-axis pen tilt in radians, screen-aligned (x right, y down). */
  x: number;
  y: number;
}

export interface InkSample {
  x: number;
  y: number;
  /** Normalized pen pressure, 0–1. */
  pressure?: number;
  /** Pen tilt vector away from normal, in radians. */
  tilt?: InkTilt;
  /** Pen barrel rotation, radians, −π–π. */
  twist?: number;
  /**
   * Milliseconds since the stroke's first sample (monotonic, relative —
   * never a wall-clock timestamp). Optional so pre-timing documents stay
   * valid; enables velocity, stabilization, resampling, and tapering.
   */
  dt?: number;
}

export type LineArrows = 'start' | 'end' | 'both';

/** Connector routing between endpoints (slice 9, whiteboard). */
export type ConnectorPath = 'straight' | 'orthogonal' | 'curved';

/** Named attachment point on a bound object's envelope bounds. */
export type ConnectorAnchor = 'center' | 'n' | 's' | 'e' | 'w';

/**
 * One bound connector endpoint: the object whose movement drags this
 * end, plus the anchor on its envelope. Absent bindings mean free
 * endpoints positioned by x/y/x2/y2. Dangling object ids resolve as
 * free (last coords win) and round-trip verbatim — deletion never
 * cascades.
 */
export interface ConnectorEndpointBinding {
  objectId: SurfaceObjectId;
  anchor: ConnectorAnchor;
}

export interface LineGeometry {
  x: number;
  y: number;
  x2: number;
  y2: number;
  color?: string;
  width?: number;
  opacity?: number;
  arrows?: LineArrows;
  path?: ConnectorPath;
  source?: ConnectorEndpointBinding;
  target?: ConnectorEndpointBinding;
}

export interface InkStrokeGeometry {
  points: readonly InkSample[];
  color?: string;
  /** Stroke width in surface units; renderers choose a default when absent. */
  width?: number;
  opacity?: number;
  rotation?: number;
  /**
   * Resolved brush captured at stroke start (kind + geometry params).
   * Absent means ball pen; later preset edits never rewrite stored strokes.
   */
  brush?: InkBrushDescriptor;
  /**
   * Logical-stroke chunking (long strokes split for the 10k record limit):
   * chunks of one continuous gesture share `logicalId` (the head object
   * id) with ascending `chunkIndex` (0-based). Internal chunk boundaries
   * are never stroke starts/ends: no internal caps, no taper restart,
   * tangent-continuous via joint derived compilation (see
   * `logical-stroke.ts`). Absent on ordinary strokes and on eraser
   * fragments (which deliberately split logical strokes into independent
   * strokes).
   */
  logicalId?: string;
  chunkIndex?: number;
}

/**
 * Canonical per-stroke brush appearance: the kind
 * plus geometry-affecting params resolved from the author's live preset
 * at capture time. Size/color/opacity stay top-level record members;
 * every field here is optional except `kind`, resolving over the kind
 * preset with record width as size.
 */
export interface InkBrushDescriptor {
  kind: InkBrushKind;
  pressure?: {
    enabled?: boolean;
    minFactor?: number;
    maxFactor?: number;
    curve?: number;
  };
  stabilization?: number;
  streamline?: number;
  velocityPressure?: boolean;
  tiltEffect?: number;
  taperStart?: number;
  taperEnd?: number;
  tip?: {
    shape?: 'round' | 'flat' | 'ellipse';
    angle?: number;
    aspect?: number;
    cap?: 'round' | 'butt';
  };
}

export interface CardGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  rotation?: number;
  fill?: string;
  stroke?: string;
  size?: number;
  color?: string;
}

export interface ResourceEmbedGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  target: {
    documentId: string;
    kindId: string;
    resourceId: string;
    address?: string;
  };
  rotation?: number;
  cachedTitle?: string;
  cachedKind?: string;
  /**
   * Additive presentation hint (delta): inline preview vs compact link.
   * Absent means `"preview"`. Unknown wire strings render as `"preview"` but
   * round-trip verbatim (never normalized on write — the record stays a
   * valid core object). No `formatVersion` bump (same precedent as Surface text
   * `role`: additive optional member, preservation-first). Accepts arbitrary
   * strings at the type level so future values compile without a cast;
   * rendering normalizes via `resourceEmbedPresentationOf` (string domain,
   * agreeing with the `resolveResourceEmbedPresentation` resolver).
   */
  presentation?: ResourceEmbedPresentation | (string & {});
}

/**
 * Resource-embed presentation hint (delta). Absent = `"preview"`.
 * Unknown strings render as `"preview"` and round-trip verbatim.
 */
export type ResourceEmbedPresentation = 'preview' | 'link';

/** Known resource-embed presentations (wire may carry unknown strings). */
export const RESOURCE_EMBED_PRESENTATIONS: readonly ResourceEmbedPresentation[] =
  ['preview', 'link'] as const;

/** True for the two known resource-embed presentations. */
export function isKnownResourceEmbedPresentation(
  value: unknown,
): value is ResourceEmbedPresentation {
  return value === 'preview' || value === 'link';
}

/**
 * Effective resource-embed presentation for rendering: known values pass
 * through; absent or unknown values use `"preview"` (the
 * `resolveResourceEmbedPresentation` resolver agrees on the string domain;
 * richer `{mode}` object tolerance lives there). The wire value is never
 * normalized — verbatim preservation stays in the record.
 */
export function resourceEmbedPresentationOf(
  record: SurfaceObjectRecord | { readonly presentation?: unknown },
): ResourceEmbedPresentation {
  const presentation = (record as { readonly presentation?: unknown })
    .presentation;
  return isKnownResourceEmbedPresentation(presentation)
    ? presentation
    : 'preview';
}

// --- Constructors (emit canonical field order per spec §5) ---

function sizedEnvelope(
  id: SurfaceObjectId,
  type: CoreSurfaceObjectType,
  geo: RectangleGeometry | ImageGeometry,
): SurfaceObjectRecord {
  return {
    id,
    type,
    x: geo.x,
    y: geo.y,
    width: geo.width,
    height: geo.height,
    ...(geo.rotation !== undefined ? { rotation: geo.rotation } : {}),
    ...('fill' in geo && geo.fill !== undefined ? { fill: geo.fill } : {}),
    ...('stroke' in geo && geo.stroke !== undefined
      ? { stroke: geo.stroke }
      : {}),
    ...('strokeWidth' in geo && geo.strokeWidth !== undefined
      ? { strokeWidth: geo.strokeWidth }
      : {}),
    ...('src' in geo ? { src: geo.src, sha256: geo.sha256 } : {}),
  };
}

export function rectangleObject(
  id: SurfaceObjectId,
  geo: RectangleGeometry,
): SurfaceObjectRecord {
  return {
    ...sizedEnvelope(id, SURFACE_OBJECT_TYPES.rectangle, geo),
    ...(geo.shape !== undefined ? { shape: geo.shape } : {}),
    ...(geo.cornerRadius !== undefined
      ? { cornerRadius: geo.cornerRadius }
      : {}),
  };
}

export function ellipseObject(
  id: SurfaceObjectId,
  geo: RectangleGeometry,
): SurfaceObjectRecord {
  return sizedEnvelope(id, SURFACE_OBJECT_TYPES.ellipse, geo);
}

export function textObject(
  id: SurfaceObjectId,
  geo: TextGeometry,
): SurfaceObjectRecord {
  return {
    id,
    type: SURFACE_OBJECT_TYPES.text,
    x: geo.x,
    y: geo.y,
    ...(geo.rotation !== undefined ? { rotation: geo.rotation } : {}),
    ...(geo.size !== undefined ? { size: geo.size } : {}),
    text: geo.text,
    // Canonical V2 order (matches frozen fixtures): `role` after `text`,
    // `color`, then `appearance` last. Unknown role strings and malformed
    // appearance members are emitted verbatim (never normalized) so
    // round-trips preserve bytes; rendering normalizes via `textRoleOf` /
    // `textAlignOf` / `textWrapWidthOf`.
    ...(geo.role !== undefined ? { role: geo.role } : {}),
    ...(geo.color !== undefined ? { color: geo.color } : {}),
    ...(geo.appearance !== undefined
      ? {
          appearance: {
            ...(geo.appearance as Record<string, unknown>),
          },
        }
      : {}),
  };
}

export function imageObject(
  id: SurfaceObjectId,
  geo: ImageGeometry,
): SurfaceObjectRecord {
  return sizedEnvelope(id, SURFACE_OBJECT_TYPES.image, geo);
}

export function lineObject(
  id: SurfaceObjectId,
  geo: LineGeometry,
): SurfaceObjectRecord {
  return {
    id,
    type: SURFACE_OBJECT_TYPES.line,
    x: geo.x,
    y: geo.y,
    x2: geo.x2,
    y2: geo.y2,
    ...(geo.color !== undefined ? { color: geo.color } : {}),
    ...(geo.width !== undefined ? { width: geo.width } : {}),
    ...(geo.opacity !== undefined ? { opacity: geo.opacity } : {}),
    ...(geo.arrows !== undefined ? { arrows: geo.arrows } : {}),
    ...(geo.path !== undefined ? { path: geo.path } : {}),
    ...(geo.source !== undefined ? { source: { ...geo.source } } : {}),
    ...(geo.target !== undefined ? { target: { ...geo.target } } : {}),
  };
}

export function inkStrokeObject(
  id: SurfaceObjectId,
  geo: InkStrokeGeometry,
): SurfaceObjectRecord {
  return {
    id,
    type: SURFACE_OBJECT_TYPES.stroke,
    points: [...geo.points],
    ...(geo.rotation !== undefined ? { rotation: geo.rotation } : {}),
    ...(geo.color !== undefined ? { color: geo.color } : {}),
    ...(geo.width !== undefined ? { width: geo.width } : {}),
    ...(geo.opacity !== undefined ? { opacity: geo.opacity } : {}),
    ...(geo.brush !== undefined ? { brush: { ...geo.brush } } : {}),
    ...(geo.logicalId !== undefined ? { logicalId: geo.logicalId } : {}),
    ...(geo.chunkIndex !== undefined ? { chunkIndex: geo.chunkIndex } : {}),
  };
}

/**
 * Logical-stroke chunk identity (long-stroke chunking): the stable head id
 * shared by every chunk of one continuous gesture, or null for ordinary
 * independent strokes. Unknown/corrupt values degrade to independent.
 */
export function logicalIdOf(record: SurfaceObjectRecord): string | null {
  const raw = (record as Record<string, unknown>).logicalId;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Zero-based chunk position within its logical stroke (0 for the head). */
export function chunkIndexOf(record: SurfaceObjectRecord): number | null {
  const raw = (record as Record<string, unknown>).chunkIndex;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0
    ? raw
    : null;
}

/** True when the record is a chunk of a multi-chunk logical stroke. */
export function isLogicalChunk(record: SurfaceObjectRecord): boolean {
  return logicalIdOf(record) !== null;
}

export function cardObject(
  id: SurfaceObjectId,
  geo: CardGeometry,
): SurfaceObjectRecord {
  return {
    id,
    type: SURFACE_OBJECT_TYPES.card,
    x: geo.x,
    y: geo.y,
    width: geo.width,
    height: geo.height,
    text: geo.text,
    ...(geo.rotation !== undefined ? { rotation: geo.rotation } : {}),
    ...(geo.fill !== undefined ? { fill: geo.fill } : {}),
    ...(geo.stroke !== undefined ? { stroke: geo.stroke } : {}),
    ...(geo.size !== undefined ? { size: geo.size } : {}),
    ...(geo.color !== undefined ? { color: geo.color } : {}),
  };
}

export function resourceEmbedObject(
  id: SurfaceObjectId,
  geo: ResourceEmbedGeometry,
): SurfaceObjectRecord {
  return {
    id,
    type: SURFACE_OBJECT_TYPES.resourceEmbed,
    x: geo.x,
    y: geo.y,
    width: geo.width,
    height: geo.height,
    target: { ...geo.target },
    ...(geo.rotation !== undefined ? { rotation: geo.rotation } : {}),
    ...(geo.cachedTitle !== undefined ? { cachedTitle: geo.cachedTitle } : {}),
    ...(geo.cachedKind !== undefined ? { cachedKind: geo.cachedKind } : {}),
    // Additive presentation (delta) emitted verbatim last, never
    // normalized, so unknown future values round-trip byte-stably
    // (Surface text `role` precedent); rendering normalizes via
    // `resourceEmbedPresentationOf` / `resolveResourceEmbedPresentation`.
    ...(geo.presentation !== undefined
      ? { presentation: geo.presentation }
      : {}),
  };
}

/**
 * Flat member group (slice 9, whiteboard): an organizational record with
 * no geometry of its own. Members keep their paint positions; the group
 * paints nothing. Nesting is rejected; groups are flat.
 */
export interface GroupGeometry {
  children: SurfaceObjectId[];
}

export function groupObject(
  id: SurfaceObjectId,
  geo: GroupGeometry,
): SurfaceObjectRecord {
  return {
    id,
    type: SURFACE_OBJECT_TYPES.group,
    children: [...geo.children],
  };
}

export function emptySurface(
  frame: SurfaceFrame = infiniteFrame(),
): SurfaceModel {
  return { formatVersion: 1, frame, order: [], objects: {} };
}

// --- Security limits (spec §9; enforced by the codec as structured errors) ---

/** Absolute magnitude cap for every geometry number, rotation included. */
export const SURFACE_MAX_COORDINATE = 1e9;
/** Maximum characters per text object. */
export const SURFACE_MAX_TEXT_LENGTH = 100_000;
/** Maximum captured samples per ink stroke. */
export const SURFACE_MAX_STROKE_POINTS = 10_000;
/**
 * Maximum per-sample `dt` in milliseconds (24 h): a single stroke never
 * spans longer. Structural validity is finite + within `[0, cap]`.
 */
export const SURFACE_MAX_SAMPLE_DT_MS = 86_400_000;

/**
 * Rebase fragment timing so the first timed sample starts at 0:
 * relative differences preserved, monotonic order kept, untimed samples
 * untouched, everything clamped inside `SURFACE_MAX_SAMPLE_DT_MS`.
 * Shared by eraser splitting (tools) and over-limit stroke recovery
 * (codec) so every fragment path rebases identically.
 */
export function rebaseStrokeTiming(run: readonly InkSample[]): InkSample[] {
  let base: number | null = null;
  for (const sample of run) {
    if (typeof sample.dt === 'number' && Number.isFinite(sample.dt)) {
      base = sample.dt;
      break;
    }
  }
  if (base === null || base === 0) {
    return run.map((sample) => ({ ...sample }));
  }
  return run.map((sample) => {
    if (typeof sample.dt !== 'number' || !Number.isFinite(sample.dt)) {
      return { ...sample };
    }
    const rebased = Math.min(
      Math.max(sample.dt - base!, 0),
      SURFACE_MAX_SAMPLE_DT_MS,
    );
    return { ...sample, dt: rebased };
  });
}

/**
 * Timing for logical-stroke chunks: the head rebases like any independent
 * stroke (first timed sample → 0); continuation chunks PRESERVE their
 * boundary `dt` (the delta from the previous chunk's last sample, clamped
 * only) so joint derived compilation restores the original timing sequence
 * exactly. Erasure retains this original source timing.
 */
export function rebaseLogicalChunkTiming(
  run: readonly InkSample[],
  isHead: boolean,
): InkSample[] {
  if (isHead) return rebaseStrokeTiming(run);
  return run.map((sample) => {
    if (typeof sample.dt !== 'number' || !Number.isFinite(sample.dt)) {
      return { ...sample };
    }
    return {
      ...sample,
      dt: Math.min(Math.max(sample.dt, 0), SURFACE_MAX_SAMPLE_DT_MS),
    };
  });
}

function geometryNumbersOf(record: SurfaceObjectRecord): number[] {
  switch (record.type) {
    case SURFACE_OBJECT_TYPES.rectangle:
    case SURFACE_OBJECT_TYPES.ellipse:
    case SURFACE_OBJECT_TYPES.image:
    case SURFACE_OBJECT_TYPES.card:
    case SURFACE_OBJECT_TYPES.resourceEmbed:
      return ['x', 'y', 'width', 'height', 'rotation', 'size'].map(
        (key) => record[key],
      ) as number[];
    case SURFACE_OBJECT_TYPES.text:
      // Surface text: `appearance.wrapWidth` is deliberately EXCLUDED from the
      // §9 hard-error scan. Non-finite/over-cap `wrapWidth` degrades
      // layout-only to unbounded (contracts §1.2 rules 2+6); only
      // x/y/rotation/size non-finite/over-cap trip FORMAT_LIMIT_EXCEEDED.
      return ['x', 'y', 'rotation', 'size'].map(
        (key) => record[key],
      ) as number[];
    case SURFACE_OBJECT_TYPES.stroke: {
      // Raw values go to the scanner verbatim: undefined entries are
      // skipped there, while non-finite ones MUST trip the §9 hard error
      // instead of being silently filtered out.
      const numbers: number[] = [];
      if (typeof record.rotation === 'number') numbers.push(record.rotation);
      if (typeof record.width === 'number') numbers.push(record.width);
      // Stored brush params are numbers too: non-finite brush values are
      // hard §9 errors like every other geometry number.
      const brush = record.brush as unknown;
      if (
        typeof brush === 'object' &&
        brush !== null &&
        !Array.isArray(brush)
      ) {
        const b = brush as Record<string, unknown>;
        const pressure = b.pressure as Record<string, unknown> | undefined;
        const tip = b.tip as Record<string, unknown> | undefined;
        numbers.push(
          b.stabilization as number,
          b.streamline as number,
          b.tiltEffect as number,
          b.taperStart as number,
          b.taperEnd as number,
          pressure?.minFactor as number,
          pressure?.maxFactor as number,
          pressure?.curve as number,
          tip?.angle as number,
          tip?.aspect as number,
        );
      }
      const points = record.points;
      if (Array.isArray(points)) {
        for (const sample of points) {
          if (typeof sample !== 'object' || sample === null) continue;
          const s = sample as Record<string, unknown>;
          numbers.push(
            s.x as number,
            s.y as number,
            s.pressure as number,
            s.twist as number,
            s.dt as number,
          );
          const tilt = s.tilt as unknown;
          if (typeof tilt === 'number') {
            // Structurally invalid, but still a hard-error candidate when
            // non-finite or over-cap so malformed numbers can never hide
            // behind opaque-with-warning recovery.
            numbers.push(tilt);
          } else if (
            typeof tilt === 'object' &&
            tilt !== null &&
            !Array.isArray(tilt)
          ) {
            const t = tilt as Record<string, unknown>;
            numbers.push(t.x as number, t.y as number);
          }
        }
      }
      return numbers as number[];
    }
    case SURFACE_OBJECT_TYPES.line:
      return [
        record.x,
        record.y,
        record.x2,
        record.y2,
        record.width,
        record.rotation,
      ] as number[];
    default:
      return [];
  }
}

/**
 * First hard security violation (spec §9) among present geometry numbers:
 * non-finite values or magnitudes beyond the coordinate cap. Null when
 * clean. Structural shape problems are NOT hard violations — they are
 * per-object recoveries (§8).
 */
export function findGeometryLimitViolation(
  record: SurfaceObjectRecord,
): string | null {
  for (const value of geometryNumbersOf(record)) {
    if (typeof value !== 'number') continue;
    if (!Number.isFinite(value)) return 'geometry number must be finite';
    if (Math.abs(value) > SURFACE_MAX_COORDINATE) {
      return `geometry magnitude exceeds ${SURFACE_MAX_COORDINATE}`;
    }
  }
  return null;
}

function optionalColor(record: SurfaceObjectRecord, key: string): boolean {
  const value = record[key];
  return value === undefined || typeof value === 'string';
}

function optionalPositiveNumber(
  record: SurfaceObjectRecord,
  key: string,
): boolean {
  const value = record[key];
  return value === undefined || (typeof value === 'number' && value > 0);
}

function optionalRotation(record: SurfaceObjectRecord): boolean {
  return record.rotation === undefined || typeof record.rotation === 'number';
}

function optionalLocked(record: SurfaceObjectRecord): boolean {
  return record.locked === undefined || typeof record.locked === 'boolean';
}

function sizedShape(record: SurfaceObjectRecord): boolean {
  const { x, y, width, height } = record;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return false;
  }
  return width >= 0 && height >= 0;
}

function isValidCardRecord(record: SurfaceObjectRecord): boolean {
  if (!sizedShape(record)) return false;
  if (typeof record.text !== 'string') return false;
  if (record.text.length > SURFACE_MAX_TEXT_LENGTH) return false;
  if (!optionalRotation(record)) return false;
  if (!optionalLocked(record)) return false;
  const size = record.size;
  if (size !== undefined && (typeof size !== 'number' || size <= 0))
    return false;
  if (!optionalColor(record, 'fill')) return false;
  if (!optionalColor(record, 'stroke')) return false;
  return optionalColor(record, 'color');
}

function isValidResourceEmbedRecord(record: SurfaceObjectRecord): boolean {
  if (!sizedShape(record)) return false;
  if (!optionalRotation(record)) return false;
  if (!optionalLocked(record)) return false;
  if (!isResourceTarget(record.target)) return false;
  if (
    record.cachedTitle !== undefined &&
    typeof record.cachedTitle !== 'string'
  )
    return false;
  if (record.cachedKind !== undefined && typeof record.cachedKind !== 'string')
    return false;
  // Presentation (delta, Surface text `role` precedent): `presentation` is
  // intentionally UNCHECKED for structural validity. Unknown strings (and
  // any other wire shape) MUST degrade render-only to preview; the record
  // stays a valid core object (no INVALID_CORE_OBJECT_OPAQUE warning, no
  // hard error). Verbatim bytes survive because the codec keeps records
  // as-is. This also keeps object-shaped values validation-neutral,
  // matching the relationships resolver tolerance.
  // Optional bindings for connector-like behavior — allowed when valid
  if (record.bindings !== undefined) {
    if (
      typeof record.bindings !== 'object' ||
      record.bindings === null ||
      Array.isArray(record.bindings)
    )
      return false;
  }
  return true;
}

function isValidGroupRecord(record: SurfaceObjectRecord): boolean {
  const children = record.children;
  if (!Array.isArray(children) || children.length === 0) return false;
  return children.every(
    (child): child is SurfaceObjectId =>
      typeof child === 'string' && child !== '',
  );
}

/** Structural validation of a core-typed record (spec §5). */
export function isValidCoreSurfaceObject(record: SurfaceObjectRecord): boolean {
  // Every core type may carry optional locked flag — invalid if wrong type.
  if (!optionalLocked(record)) return false;
  switch (record.type) {
    case SURFACE_OBJECT_TYPES.rectangle: {
      if (
        record.cornerRadius !== undefined &&
        (typeof record.cornerRadius !== 'number' ||
          !Number.isFinite(record.cornerRadius) ||
          record.cornerRadius < 0 ||
          record.cornerRadius > SURFACE_MAX_COORDINATE)
      )
        return false;
      if (
        record.shape !== undefined &&
        !['rectangle', 'rounded', 'diamond', 'triangle'].includes(
          String(record.shape),
        )
      )
        return false;
      if (!sizedShape(record)) return false;
      if (!optionalRotation(record)) return false;
      return (
        optionalColor(record, 'fill') &&
        optionalColor(record, 'stroke') &&
        optionalPositiveNumber(record, 'strokeWidth')
      );
    }
    case SURFACE_OBJECT_TYPES.ellipse: {
      if (!sizedShape(record)) return false;
      if (!optionalRotation(record)) return false;
      return (
        optionalColor(record, 'fill') &&
        optionalColor(record, 'stroke') &&
        optionalPositiveNumber(record, 'strokeWidth')
      );
    }
    case SURFACE_OBJECT_TYPES.text: {
      const { x, y, text } = record;
      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        typeof text !== 'string'
      ) {
        return false;
      }
      if (text.length > SURFACE_MAX_TEXT_LENGTH) return false;
      if (!optionalRotation(record)) return false;
      const size = record.size;
      if (size !== undefined && (typeof size !== 'number' || size <= 0))
        return false;
      if (!optionalColor(record, 'color')) return false;
      // Surface text: `role` / `appearance`
      // are intentionally UNCHECKED for structural validity. Unknown
      // roles, unknown aligns, malformed `appearance` shapes, and invalid
      // `wrapWidth` (wrong type, non-finite, <= 0, over-cap) MUST degrade
      // layout-only to body/start/unbounded; the record stays a valid
      // core object (no INVALID_CORE_OBJECT_OPAQUE warning, no hard
      // error). `findGeometryLimitViolation` deliberately excludes
      // `appearance` so bad `wrapWidth` never trips §9. Verbatim bytes
      // survive because the codec keeps records as-is.
      return true;
    }
    case SURFACE_OBJECT_TYPES.image: {
      if (!sizedShape(record)) return false;
      if (!optionalRotation(record)) return false;
      if (typeof record.src !== 'string' || typeof record.sha256 !== 'string')
        return false;
      return !isUnsafeAssetSrc(record.src);
    }
    case SURFACE_OBJECT_TYPES.inkSource:
      return (
        (record.sampleEncoding === undefined ||
          record.sampleEncoding === 'packed') &&
        Number.isSafeInteger(record.outlineLength) &&
        (record.outlineLength as number) >= 3 &&
        Array.isArray(record.chunks) &&
        record.chunks.length > 0 &&
        record.chunks.every(
          (chunk) =>
            typeof chunk === 'object' &&
            chunk !== null &&
            isValidInkStrokeRecord(chunk as SurfaceObjectRecord) &&
            Array.isArray((chunk as SurfaceObjectRecord).points) &&
            ((chunk as SurfaceObjectRecord).points as unknown[]).length <=
              SURFACE_MAX_STROKE_POINTS,
        )
      );
    case SURFACE_OBJECT_TYPES.stroke:
      return isValidInkStrokeRecord(record);
    case SURFACE_OBJECT_TYPES.line:
      return isValidLineRecord(record);
    case SURFACE_OBJECT_TYPES.card:
      return isValidCardRecord(record);
    case SURFACE_OBJECT_TYPES.resourceEmbed:
      return isValidResourceEmbedRecord(record);
    case SURFACE_OBJECT_TYPES.group:
      return isValidGroupRecord(record);
    default:
      return false;
  }
}

function isValidInkTilt(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const t = value as Record<string, unknown>;
  if (typeof t.x !== 'number' || !Number.isFinite(t.x)) return false;
  if (typeof t.y !== 'number' || !Number.isFinite(t.y)) return false;
  const halfPi = Math.PI / 2;
  if (t.x < -halfPi || t.x > halfPi || t.y < -halfPi || t.y > halfPi)
    return false;
  return true;
}

function isValidInkSample(sample: unknown): boolean {
  if (typeof sample !== 'object' || sample === null || Array.isArray(sample)) {
    return false;
  }
  const s = sample as Record<string, unknown>;
  if (typeof s.x !== 'number' || !Number.isFinite(s.x)) return false;
  if (typeof s.y !== 'number' || !Number.isFinite(s.y)) return false;
  const axis = (value: unknown, min: number, max: number): boolean => {
    if (value === undefined) return true;
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    return value >= min && value <= max;
  };
  if (!axis(s.pressure, 0, 1)) return false;
  if (s.tilt !== undefined) {
    if (!isValidInkTilt(s.tilt)) return false;
  }
  if (!axis(s.twist, -Math.PI, Math.PI)) return false;
  if (s.dt !== undefined) {
    if (typeof s.dt !== 'number' || !Number.isFinite(s.dt)) return false;
    if (s.dt < 0 || s.dt > SURFACE_MAX_SAMPLE_DT_MS) return false;
  }
  return true;
}

const LINE_ARROWS: ReadonlySet<string> = new Set(['start', 'end', 'both']);

const CONNECTOR_PATHS: ReadonlySet<string> = new Set([
  'straight',
  'orthogonal',
  'curved',
]);

const CONNECTOR_ANCHORS: ReadonlySet<string> = new Set([
  'center',
  'n',
  's',
  'e',
  'w',
]);

function isValidConnectorBinding(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const binding = value as Record<string, unknown>;
  if (typeof binding.objectId !== 'string' || binding.objectId === '') {
    return false;
  }
  return (
    typeof binding.anchor === 'string' && CONNECTOR_ANCHORS.has(binding.anchor)
  );
}

function isValidLineRecord(record: SurfaceObjectRecord): boolean {
  for (const key of ['x', 'y', 'x2', 'y2'] as const) {
    if (typeof record[key] !== 'number') return false;
  }
  const width = record.width;
  if (width !== undefined && (typeof width !== 'number' || !(width > 0)))
    return false;
  const opacity = record.opacity;
  if (
    opacity !== undefined &&
    (typeof opacity !== 'number' || opacity < 0 || opacity > 1)
  ) {
    return false;
  }
  if (
    record.arrows !== undefined &&
    !LINE_ARROWS.has(record.arrows as string)
  ) {
    return false;
  }
  if (
    record.path !== undefined &&
    !CONNECTOR_PATHS.has(record.path as string)
  ) {
    return false;
  }
  if (record.source !== undefined && !isValidConnectorBinding(record.source)) {
    return false;
  }
  if (record.target !== undefined && !isValidConnectorBinding(record.target)) {
    return false;
  }
  return optionalColor(record, 'color');
}

function isValidInkStrokeRecord(record: SurfaceObjectRecord): boolean {
  if (record.erasure !== undefined) return false;
  if (record.sourceId !== undefined)
    return (
      validInkRegionRecord(record) &&
      isValidInkStrokeRecord({
        ...record,
        sourceId: undefined,
        points: [{ x: 0, y: 0 }],
      })
    );
  const points = record.points;
  if (!Array.isArray(points) || points.length === 0) return false;
  for (const sample of points) {
    if (!isValidInkSample(sample)) return false;
  }
  const width = record.width;
  if (width !== undefined && (typeof width !== 'number' || !(width > 0))) {
    return false;
  }
  const opacity = record.opacity;
  if (
    opacity !== undefined &&
    (typeof opacity !== 'number' || opacity < 0 || opacity > 1)
  ) {
    return false;
  }
  if (record.brush !== undefined && !isValidInkBrush(record.brush)) {
    return false;
  }
  return optionalColor(record, 'color') && optionalRotation(record);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteIn(
  value: unknown,
  min: number,
  max: number,
  exclusiveMin = false,
): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return exclusiveMin
    ? value > min && value <= max
    : value >= min && value <= max;
}

/** Structural validation of the stored per-stroke brush member (§5.1). */
function isValidInkBrush(brush: unknown): boolean {
  if (!isPlainRecord(brush)) return false;
  if (
    typeof brush.kind !== 'string' ||
    !(INK_BRUSH_KINDS as readonly string[]).includes(brush.kind)
  ) {
    return false;
  }
  if (brush.pressure !== undefined) {
    if (!isPlainRecord(brush.pressure)) return false;
    const p = brush.pressure;
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') return false;
    if (p.minFactor !== undefined && !isFiniteIn(p.minFactor, 0, 1e9))
      return false;
    if (p.maxFactor !== undefined && !isFiniteIn(p.maxFactor, 0, 1e9))
      return false;
    if (p.curve !== undefined && !isFiniteIn(p.curve, 0, 1e9, true))
      return false;
  }
  if (
    brush.stabilization !== undefined &&
    !isFiniteIn(brush.stabilization, 0, 1)
  ) {
    return false;
  }
  if (brush.streamline !== undefined && !isFiniteIn(brush.streamline, 0, 1)) {
    return false;
  }
  if (
    brush.velocityPressure !== undefined &&
    typeof brush.velocityPressure !== 'boolean'
  ) {
    return false;
  }
  if (brush.tiltEffect !== undefined && !isFiniteIn(brush.tiltEffect, 0, 1)) {
    return false;
  }
  if (brush.taperStart !== undefined && !isFiniteIn(brush.taperStart, 0, 1)) {
    return false;
  }
  if (brush.taperEnd !== undefined && !isFiniteIn(brush.taperEnd, 0, 1)) {
    return false;
  }
  if (brush.tip !== undefined) {
    if (!isPlainRecord(brush.tip)) return false;
    const tip = brush.tip;
    if (
      tip.shape !== undefined &&
      tip.shape !== 'round' &&
      tip.shape !== 'flat' &&
      tip.shape !== 'ellipse'
    ) {
      return false;
    }
    if (tip.angle !== undefined && !isFiniteIn(tip.angle, -1e9, 1e9)) {
      return false;
    }
    if (tip.aspect !== undefined && !isFiniteIn(tip.aspect, 0, 1)) {
      return false;
    }
    if (tip.cap !== undefined && tip.cap !== 'round' && tip.cap !== 'butt') {
      return false;
    }
  }
  return true;
}
