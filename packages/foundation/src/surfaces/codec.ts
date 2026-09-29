import { inkSourceOutline } from './ink/source-geometry.js';
import {
  INK_SOURCE_TYPE,
  freezeInkValue,
  bindInkSource,
  validInkVisible,
} from './ink/fragments.js';
/**
 * Surface payload codec.
 * Engine-free: no editor, renderer, DOM, or host types.
 *
 * Preservation-first: parsed records are kept verbatim so unknown fields,
 * object types, and frame members round-trip byte-stably (spec §7).
 */

import { FroglightError } from '../errors.js';
import { isUnsafeAssetSrc } from '../blocks/model.js';
import {
  parseJsonAsync,
  utf8Decode,
  utf8Encode,
  utf8EncodeJsonAsync,
} from '../encoding.js';
import {
  INK_DEFAULT_WIDTH,
  brushPresetForKind,
  resolveBrushSpec,
} from './ink/brush.js';
import type { Bounds } from './geometry.js';
import {
  type JsonValue,
  SURFACE_MAX_COORDINATE,
  SURFACE_MAX_STROKE_POINTS,
  SURFACE_MAX_TEXT_LENGTH,
  findGeometryLimitViolation,
  inkStrokeObject,
  isCoreSurfaceObjectType,
  isValidCoreSurfaceObject,
  rebaseLogicalChunkTiming,
  SURFACE_OBJECT_TYPES,
  type InkBrushDescriptor,
  type InkSample,
  type SurfaceModel,
  type SurfaceObjectId,
  type SurfaceObjectRecord,
} from './model.js';

export const SURFACE_FORMAT_VERSION = 1;

/** Security limits per spec §9. */
export const SURFACE_LIMITS = {
  maxFileBytes: 32 * 1024 * 1024,
  maxObjects: 100_000,
  maxCoordinate: SURFACE_MAX_COORDINATE,
  maxTextLength: SURFACE_MAX_TEXT_LENGTH,
  maxStrokePoints: SURFACE_MAX_STROKE_POINTS,
} as const;

/** Machine-readable recovery annotations (spec §8); never free text. */
export type SurfaceWarningCode =
  | 'MALFORMED_OBJECT_DROPPED'
  | 'INVALID_CORE_OBJECT_OPAQUE'
  | 'DUPLICATE_ORDER_REFERENCE'
  | 'DANGLING_ORDER_REFERENCE'
  | 'OBJECT_MISSING_FROM_ORDER'
  | 'STROKE_SPLIT_FOR_LIMIT';

export interface SurfaceWarning {
  readonly code: SurfaceWarningCode;
  /** The damaged or repaired object, when applicable. */
  readonly objectId?: SurfaceObjectId;
  /** The referenced id that was removed or deduplicated, when applicable. */
  readonly refId?: SurfaceObjectId;
}

export interface DecodeSurfacePayloadResult {
  readonly model: SurfaceModel;
  /** Partial-recovery notes (spec §8); empty for clean decodes. */
  readonly warnings: readonly SurfaceWarning[];
  /**
   * Derived bounds seeds (item 5): conservative rendered envelopes for Ink
   * strokes, computed during the decode pass (no second sample scan).
   * Derived-only — never canonical file content. Callers seed
   * spatial/derived indexes from this instead of rescanning samples.
   */
  readonly seedBounds: ReadonlyMap<
    string,
    import('./geometry.js').Bounds | null
  >;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function corrupt(message: string): FroglightError {
  return new FroglightError('RECORD_CORRUPT', `surface payload: ${message}`);
}

function limit(message: string): FroglightError {
  return new FroglightError(
    'FORMAT_LIMIT_EXCEEDED',
    `surface payload: ${message}`,
  );
}

/** Structural validation of a bounded/infinite frame record (spec §4). */
function isValidFrame(frame: unknown): boolean {
  if (!isPlainObject(frame)) return false;
  if (frame.kind === 'infinite') return true;
  if (frame.kind === 'bounded') {
    const { width, height } = frame as Record<string, unknown>;
    if (typeof width !== 'number' || typeof height !== 'number') return false;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
    // Magnitude is a security limit; positivity is structure.
    if (width <= 0 || height <= 0) return false;
    if (
      Math.abs(width) > SURFACE_MAX_COORDINATE ||
      Math.abs(height) > SURFACE_MAX_COORDINATE
    ) {
      throw limit('frame magnitude exceeds the coordinate cap');
    }
    return true;
  }
  return false;
}

/** Hard text-length check for core text objects (spec §9). */
function checkTextLimit(record: SurfaceObjectRecord): void {
  if (
    record.type !== 'froglight.text' &&
    record.type !== SURFACE_OBJECT_TYPES.card
  )
    return;
  const text = (record as Record<string, unknown>).text;
  if (typeof text === 'string' && text.length > SURFACE_LIMITS.maxTextLength) {
    throw limit(`text object "${record.id}" exceeds max text length`);
  }
}

/**
 * Lossless split of an over-limit stroke into sequential fragments of at
 * most `maxStrokePoints` samples each (recovery). Style, brush,
 * rotation, and unknown members survive verbatim per chunk. Timing follows
 * the logical-chunk contract, preserving the original full sequence. The head
 * fragment keeps the original id so existing single-target references
 * (connector bindings) keep pointing at the stroke start; later fragments
 * take deterministic collision-free `${id}#part${n}` ids. Splitting
 * preserves every sample — never truncation — so the security posture is
 * unchanged (total size stays bounded by the file cap; per-object counts
 * stay bounded after recovery).
 *
 * Returns the recovery mapping `old object id → all replacement ids`
 * (head first, in paint order) alongside the fragment records. Callers
 * must rewrite every reference-bearing structure through this mapping
 * (see `rewriteSplitReferences`): paint order expands to all fragments,
 * groups expand to all fragments, single-target bindings keep the head.
 */
function splitOverLimitStroke(
  key: string,
  record: SurfaceObjectRecord,
  points: unknown[],
  takenIds: Set<string>,
): { ids: string[]; records: SurfaceObjectRecord[] } {
  const cap = SURFACE_LIMITS.maxStrokePoints;
  const raw = record as Record<string, unknown>;
  const extras: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (
      field !== 'id' &&
      field !== 'type' &&
      field !== 'points' &&
      field !== 'rotation' &&
      field !== 'color' &&
      field !== 'width' &&
      field !== 'opacity' &&
      field !== 'brush' &&
      field !== 'logicalId' &&
      field !== 'chunkIndex'
    ) {
      extras[field] = value;
    }
  }
  const brush = raw.brush;
  const brushMember =
    typeof brush === 'object' && brush !== null
      ? { ...(brush as Record<string, unknown>) }
      : undefined;
  const ids: string[] = [];
  const records: SurfaceObjectRecord[] = [];
  const parts = Math.ceil(points.length / cap);
  // The original key is being replaced: free it so the head fragment
  // keeps the stable id while later fragments take suffixed ids. Chunks
  // share the head id as `logicalId` (one continuous gesture, joint
  // derived compilation — no internal caps/taper restarts).
  takenIds.delete(key);
  const logicalId =
    typeof raw.logicalId === 'string' && raw.logicalId.length > 0
      ? (raw.logicalId as string)
      : key;
  for (let part = 0; part < parts; part++) {
    const run = points.slice(part * cap, (part + 1) * cap);
    let id = part === 0 ? key : `${key}#part${part + 1}`;
    while (takenIds.has(id)) id = `${id}#part`;
    takenIds.add(id);
    records.push({
      ...inkStrokeObject(id, {
        points: rebaseLogicalChunkTiming(run as InkSample[], part === 0),
        ...(typeof raw.rotation === 'number' ? { rotation: raw.rotation } : {}),
        ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
        ...(typeof raw.width === 'number' ? { width: raw.width } : {}),
        ...(typeof raw.opacity === 'number' ? { opacity: raw.opacity } : {}),
        ...(brushMember !== undefined
          ? { brush: brushMember as unknown as InkBrushDescriptor }
          : {}),
        logicalId,
        chunkIndex: part,
      }),
      ...extras,
    } as SurfaceObjectRecord);
    ids.push(id);
  }
  return { ids, records };
}

/**
 * Rewrite every canonical object-ID reference through the split-recovery
 * mapping (`old id → all fragment ids`, head first).
 *
 * - paint order is expanded by the caller (fragments keep the original
 *   paint position, in sequence);
 * - group `children` expand a split member to ALL fragments in order, so
 *   move/duplicate/delete/lock verbs continue to cover the whole stroke;
 * - connector `source`/`target` bindings keep the HEAD fragment (the
 *   original id): a binding is single-target and cannot fan out, and the
 *   head preserves the stroke start anchor. Dangling bindings round-trip
 *   verbatim (deletion never cascades);
 * - malformed/dangling references are preserved verbatim (groups tolerate
 *   dangling children silently; order drops dangling with a warning via
 *   the caller; bindings resolve as free).
 *
 * Unknown/opaque object types are never traversed (their payloads round-
 * trip verbatim per spec §6); only core `froglight.group` and
 * `froglight.line` bindings are reference-bearing in v1.
 */
function rewriteSplitReferences(
  objects: Record<string, SurfaceObjectRecord>,
  splits: ReadonlyMap<string, readonly string[]>,
): void {
  if (splits.size === 0) return;
  for (const record of Object.values(objects)) {
    if (record.type === SURFACE_OBJECT_TYPES.group) {
      const children = (record as Record<string, unknown>).children;
      if (!Array.isArray(children)) continue;
      let expanded = false;
      const next: unknown[] = [];
      for (const child of children) {
        if (typeof child === 'string') {
          const fragments = splits.get(child);
          if (fragments !== undefined) {
            for (const fragmentId of fragments) next.push(fragmentId);
            expanded = true;
            continue;
          }
        }
        next.push(child);
      }
      if (expanded) {
        (record as Record<string, unknown>).children = next;
      }
      continue;
    }
    if (record.type === SURFACE_OBJECT_TYPES.line) {
      // Single-target bindings follow the head (original id — already
      // correct). Rewrite explicitly only when a binding points at a
      // non-head fragment id that no longer exists as a standalone
      // object (defensive: head keeps the original id, so normally a
      // no-op). Dangling bindings are preserved verbatim.
      for (const end of ['source', 'target'] as const) {
        const binding = (record as Record<string, unknown>)[end];
        if (
          typeof binding === 'object' &&
          binding !== null &&
          !Array.isArray(binding)
        ) {
          const objectId = (binding as Record<string, unknown>).objectId;
          if (typeof objectId === 'string' && splits.has(objectId)) {
            // Head keeps the original id — binding already correct.
            // No rewrite needed; kept explicit for the normative mapping.
            continue;
          }
        }
      }
      continue;
    }
  }
}
/**
 * Partial recovery pass (spec §8): drops malformed entries, flags invalid
 * core records as opaque, dedupes paint order, removes dangling
 * references, and appends orphaned objects. Copy-on-write: clean
 * payloads are never mutated.
 */
function seedPadFor(record: SurfaceObjectRecord): number {
  const widthRaw = (record as Record<string, unknown>).width;
  const size =
    typeof widthRaw === 'number' && widthRaw > 0 ? widthRaw : INK_DEFAULT_WIDTH;
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
  try {
    const brush = resolveBrushSpec(
      { ...(stored as object), kind, size } as never,
      brushPresetForKind(kind as never),
    );
    const pressureMax = brush.pressure.enabled
      ? Math.max(brush.pressure.maxFactor, 0)
      : 1;
    return Math.max((brush.size / 2) * pressureMax * (1 + brush.tiltEffect), 0);
  } catch {
    return size / 2;
  }
}

/**
 * Conservative Ink envelope from raw samples (item 5): single pass over
 * `record.points` during decode, no `InkSample[]` allocation. Brush-width
 * padding matches the derived-store envelope so seeded bounds contain the
 * rendered outline exactly like a later rescan would.
 */
function seedInkBounds(record: SurfaceObjectRecord): Bounds | null {
  if (
    record.type === SURFACE_OBJECT_TYPES.stroke &&
    record.sourceId !== undefined
  )
    return null;
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
  const pad = seedPadFor(record);
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}

type RecoveredSurface = {
  objects: Record<string, SurfaceObjectRecord>;
  order: string[];
  seedBounds: Map<string, Bounds | null>;
};

function* recoverStructureSteps(
  rawObjects: Record<string, unknown>,
  rawOrder: string[],
  warnings: SurfaceWarning[],
): Generator<void, RecoveredSurface> {
  const objects: Record<string, SurfaceObjectRecord> = {};
  const takenIds = new Set<string>(Object.keys(rawObjects));
  // Original id -> recovered fragment ids (over-limit stroke splits).
  const splits = new Map<string, string[]>();
  const storeCoreRecord = (key: string, record: SurfaceObjectRecord): void => {
    if (!isValidCoreSurfaceObject(record) || record.id !== key) {
      warnings.push({ code: 'INVALID_CORE_OBJECT_OPAQUE', objectId: key });
    }
    objects[key] = record;
  };
  let processed = 0;
  let objectBatch = 0;
  let pointBatch = 0;
  for (const [key, value] of Object.entries(rawObjects)) {
    objectBatch++;
    if (isPlainObject(value) && Array.isArray(value.points))
      pointBatch += value.points.length;
    if (objectBatch >= 256 || pointBatch >= 8_192) {
      yield;
      objectBatch = 0;
      pointBatch = 0;
    }
    if (!isPlainObject(value)) {
      warnings.push({ code: 'MALFORMED_OBJECT_DROPPED', objectId: key });
      continue;
    }
    const record = value as SurfaceObjectRecord;
    if (
      typeof record.type !== 'string' ||
      typeof record.id !== 'string' ||
      record.id === ''
    ) {
      warnings.push({ code: 'MALFORMED_OBJECT_DROPPED', objectId: key });
      continue;
    }
    if (isCoreSurfaceObjectType(record.type)) {
      // Security limits are hard errors even inside recovery (spec §9).
      if (record.type === INK_SOURCE_TYPE) {
        if (!isValidCoreSurfaceObject(record))
          throw corrupt(`invalid ink source "${key}"`);
        for (const chunk of record.chunks as SurfaceObjectRecord[]) {
          const violation = findGeometryLimitViolation(chunk);
          if (violation !== null)
            throw limit(`${violation} in ink source "${key}"`);
        }
        freezeInkValue(record);
      }
      if (
        record.type === SURFACE_OBJECT_TYPES.stroke &&
        record.sourceId !== undefined
      ) {
        if (!isValidCoreSurfaceObject(record))
          throw corrupt(`invalid ink region in object "${key}"`);
        freezeInkValue(record.visible);
        freezeInkValue(record.regionTransform);
      }
      const violation = findGeometryLimitViolation(record);
      if (violation !== null) throw limit(`${violation} in object "${key}"`);
      checkTextLimit(record);
      if (
        record.type === SURFACE_OBJECT_TYPES.stroke &&
        record.erasure !== undefined
      ) {
        throw corrupt(`unsupported source-mask ink erasure in object "${key}"`);
      }
      const rawPoints = (record as Record<string, unknown>).points;
      if (
        record.type === SURFACE_OBJECT_TYPES.stroke &&
        Array.isArray(rawPoints) &&
        rawPoints.length > SURFACE_LIMITS.maxStrokePoints
      ) {
        // Over-limit strokes split losslessly instead of refusing the
        // whole document: every sample survives across
        // sequential fragments, each within the cap. One warning per
        // split operation, never per fragment.
        if (record.id !== key) {
          warnings.push({ code: 'INVALID_CORE_OBJECT_OPAQUE', objectId: key });
        }
        const { ids, records } = splitOverLimitStroke(
          key,
          record,
          rawPoints,
          takenIds,
        );
        for (let i = 0; i < ids.length; i++) {
          storeCoreRecord(ids[i]!, records[i]!);
        }
        splits.set(key, ids);
        warnings.push({ code: 'STROKE_SPLIT_FOR_LIMIT', objectId: key });
        continue;
      }
      if (
        record.type === 'froglight.image' &&
        typeof record.src === 'string' &&
        isUnsafeAssetSrc(record.src)
      ) {
        // Path escapes are a hard security error, not partial recovery
        // (spec §5, mirroring the block-page format §8).
        throw limit(`image "${key}" references an unsafe asset path`);
      }
      storeCoreRecord(key, record);
      continue;
    }
    objects[key] = record;
  }

  // Rewrite every reference-bearing structure through the split mapping
  // before paint-order expansion: groups expand to ALL fragments (so
  // move/duplicate/delete/lock cover the whole stroke); line bindings
  // keep the head (single-target, original id). Order expansion below
  // keeps fragments in original paint position, in sequence.
  rewriteSplitReferences(objects, splits);

  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of rawOrder) {
    if (++processed % 256 === 0) yield;
    if (seen.has(id)) {
      warnings.push({ code: 'DUPLICATE_ORDER_REFERENCE', refId: id });
      continue;
    }
    seen.add(id);
    const split = splits.get(id);
    if (split !== undefined) {
      // Fragments keep the original paint position, in sequence.
      for (const fragmentId of split) {
        seen.add(fragmentId);
        if (fragmentId in objects) order.push(fragmentId);
      }
      continue;
    }
    if (!(id in objects)) {
      warnings.push({ code: 'DANGLING_ORDER_REFERENCE', refId: id });
      continue;
    }
    if (objects[id]?.type === INK_SOURCE_TYPE)
      throw corrupt('ink sources must not occur in paint order');
    order.push(id);
  }
  for (const id of Object.keys(objects)) {
    if (++processed % 256 === 0) yield;
    if (!seen.has(id) && objects[id]?.type !== INK_SOURCE_TYPE) {
      warnings.push({ code: 'OBJECT_MISSING_FROM_ORDER', objectId: id });
      order.push(id);
    }
  }

  // Derived seed pass (item 5): conservative Ink envelopes computed during
  // decode (same outer object loop, no later full-document rescan). Only
  // Ink strokes need seeding (sized boxes are O(1) anyway). Split fragments
  // each seed their own envelope.
  const seedBounds = new Map<string, Bounds | null>();
  objectBatch = 0;
  pointBatch = 0;
  for (const [id, record] of Object.entries(objects)) {
    objectBatch++;
    if (Array.isArray(record.points)) pointBatch += record.points.length;
    if (objectBatch >= 256 || pointBatch >= 8_192) {
      yield;
      objectBatch = 0;
      pointBatch = 0;
    }
    if (record.type === SURFACE_OBJECT_TYPES.stroke) {
      try {
        seedBounds.set(id, seedInkBounds(record));
      } catch {
        seedBounds.set(id, null);
      }
    }
  }

  return { objects, order, seedBounds };
}

function recoverStructure(
  rawObjects: Record<string, unknown>,
  rawOrder: string[],
  warnings: SurfaceWarning[],
): RecoveredSurface {
  const steps = recoverStructureSteps(rawObjects, rawOrder, warnings);
  while (true) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

async function recoverStructureAsync(
  rawObjects: Record<string, unknown>,
  rawOrder: string[],
  warnings: SurfaceWarning[],
  isCurrent: () => boolean,
): Promise<RecoveredSurface | null> {
  const steps = recoverStructureSteps(rawObjects, rawOrder, warnings);
  while (true) {
    const step = steps.next();
    if (step.done) return isCurrent() ? step.value : null;
    await yieldDecodeTask();
    if (!isCurrent()) return null;
  }
}

async function yieldDecodeTask(): Promise<void> {
  const scope = globalThis as unknown as {
    scheduler?: { yield?: () => Promise<void> };
    setTimeout(task: () => void, delayMs: number): unknown;
  };
  if (scope.scheduler?.yield !== undefined) await scope.scheduler.yield();
  else await new Promise<void>((resolve) => scope.setTimeout(resolve, 0));
}

/** Decode canonical surface payload bytes into a model plus warnings. */
export function decodeSurfacePayload(
  data: Uint8Array,
): DecodeSurfacePayloadResult {
  if (data.byteLength > SURFACE_LIMITS.maxFileBytes) {
    throw limit('payload exceeds max file size');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(data));
  } catch {
    throw corrupt('not valid JSON');
  }
  return decodeSurfacePayloadValue(parsed);
}

/** Decode with task-sized JSON parsing for opening large surfaces. */
export async function decodeSurfacePayloadAsync(
  data: Uint8Array,
  isCurrent: () => boolean,
): Promise<DecodeSurfacePayloadResult | null> {
  if (data.byteLength > SURFACE_LIMITS.maxFileBytes) {
    throw limit('payload exceeds max file size');
  }
  let parsed: unknown | null;
  try {
    parsed = await parseJsonAsync(data, isCurrent);
  } catch {
    if (!isCurrent()) return null;
    throw corrupt('not valid JSON');
  }
  if (parsed === null && !isCurrent()) return null;
  return decodeSurfacePayloadValueAsync(parsed, isCurrent);
}

export async function decodeSurfacePayloadValueAsync(
  parsed: unknown,
  isCurrent: () => boolean,
): Promise<DecodeSurfacePayloadResult | null> {
  if (!isCurrent()) return null;
  const envelope = readSurfaceEnvelope(parsed);
  const warnings: SurfaceWarning[] = [];
  const recovered = await recoverStructureAsync(
    envelope.rawObjects,
    envelope.rawOrder,
    warnings,
    isCurrent,
  );
  if (recovered === null || !isCurrent()) return null;
  return finishSurfacePayload(
    parsed as Record<string, unknown>,
    envelope,
    recovered,
    warnings,
  );
}

interface SurfacePayloadEnvelope {
  readonly parsed: Record<string, unknown>;
  readonly formatVersion: typeof SURFACE_FORMAT_VERSION;
  readonly rawFrame: unknown;
  readonly rawOrder: string[];
  readonly rawObjects: Record<string, unknown>;
}

function readSurfaceEnvelope(parsed: unknown): SurfacePayloadEnvelope {
  if (!isPlainObject(parsed)) throw corrupt('document is not a JSON object');

  const formatVersion = parsed.formatVersion;
  if (typeof formatVersion !== 'number') throw corrupt('missing formatVersion');
  if (
    !Number.isInteger(formatVersion) ||
    formatVersion !== SURFACE_FORMAT_VERSION
  ) {
    // Unknown versions (newer, zero, negative, fractional) are rejected,
    // never best-effort parsed (spec §2).
    throw new FroglightError(
      'UNKNOWN_FORMAT_VERSION',
      `surface payload formatVersion ${String(formatVersion)} is not supported (v${SURFACE_FORMAT_VERSION})`,
    );
  }

  const rawFrame = parsed.frame;
  if (!isValidFrame(rawFrame))
    throw corrupt('frame must be a bounded or infinite descriptor');

  const rawOrder = parsed.order;
  if (
    !Array.isArray(rawOrder) ||
    rawOrder.some((id) => typeof id !== 'string')
  ) {
    throw corrupt('order must be an array of object ids');
  }
  const rawObjects = parsed.objects;
  if (!isPlainObject(rawObjects)) throw corrupt('objects must be an object');
  if (Object.keys(rawObjects).length > SURFACE_LIMITS.maxObjects) {
    throw limit('payload exceeds max object count');
  }
  return {
    parsed,
    formatVersion,
    rawFrame,
    rawOrder: rawOrder as string[],
    rawObjects,
  };
}

export function decodeSurfacePayloadValue(
  parsed: unknown,
): DecodeSurfacePayloadResult {
  const envelope = readSurfaceEnvelope(parsed);
  const warnings: SurfaceWarning[] = [];
  const recovered = recoverStructure(
    envelope.rawObjects as Record<string, SurfaceObjectRecord>,
    envelope.rawOrder,
    warnings,
  );
  return finishSurfacePayload(envelope.parsed, envelope, recovered, warnings);
}

function finishSurfacePayload(
  parsed: Record<string, unknown>,
  envelope: SurfacePayloadEnvelope,
  recovered: RecoveredSurface,
  warnings: SurfaceWarning[],
): DecodeSurfacePayloadResult {
  // Records are consumed as-is: preservation is the default; only structural
  // damage is repaired, each action annotated as a warning (spec §8).
  for (const record of Object.values(recovered.objects)) {
    if (
      record.type === SURFACE_OBJECT_TYPES.stroke &&
      record.sourceId !== undefined
    ) {
      const source = recovered.objects[record.sourceId as string];
      if (source?.type !== INK_SOURCE_TYPE)
        throw corrupt(`unresolved ink source in object "${record.id}"`);
      if (!validInkVisible(record.visible, source.outlineLength as number))
        throw corrupt(`invalid ink source boundary in object "${record.id}"`);
      inkSourceOutline(source);
      bindInkSource(record, source);
    }
  }
  const unknownFields: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      key !== 'formatVersion' &&
      key !== 'frame' &&
      key !== 'order' &&
      key !== 'objects'
    ) {
      unknownFields[key] = value as JsonValue;
    }
  }
  const model: SurfaceModel = {
    formatVersion: envelope.formatVersion,
    frame: envelope.rawFrame as SurfaceModel['frame'],
    order: recovered.order,
    objects: recovered.objects,
    ...(Object.keys(unknownFields).length > 0 ? { unknownFields } : {}),
  };
  return { model, warnings, seedBounds: recovered.seedBounds };
}

/** Deterministic canonical serializer (spec §7): 2-space indent, LF, trailing newline. */
export function validateSurfaceForWrite(model: SurfaceModel): void {
  decodeSurfacePayloadValue({ ...model, ...(model.unknownFields ?? {}) });
}

export function canonicalSurfaceJson(model: SurfaceModel): string {
  validateSurfaceForWrite(model);
  const { unknownFields, ...known } = model as SurfaceModel &
    Record<string, unknown>;
  known.formatVersion = SURFACE_FORMAT_VERSION;
  if (unknownFields && typeof unknownFields === 'object') {
    return `${JSON.stringify({ ...known, ...unknownFields }, null, 2)}\n`;
  }
  return `${JSON.stringify(known, null, 2)}\n`;
}

/** Encode a model back to canonical bytes. */
export function encodeSurfacePayload(model: SurfaceModel): Uint8Array {
  const bytes = utf8Encode(canonicalSurfaceJson(model));
  if (bytes.byteLength > SURFACE_LIMITS.maxFileBytes)
    throw limit('document exceeds max file size');
  return bytes;
}

/** Encode a coherent Surface payload while yielding between JSON fragments. */
export async function encodeSurfacePayloadAsync(
  model: SurfaceModel,
  isCurrent: () => boolean,
): Promise<Uint8Array | null> {
  const { unknownFields, ...known } = model as SurfaceModel &
    Record<string, unknown>;
  known.formatVersion = SURFACE_FORMAT_VERSION;
  const payload =
    unknownFields && typeof unknownFields === 'object'
      ? { ...known, ...unknownFields }
      : known;
  validateSurfaceForWrite(model);
  const bytes = await utf8EncodeJsonAsync(payload, isCurrent, true);
  if (bytes !== null && bytes.byteLength > SURFACE_LIMITS.maxFileBytes)
    throw limit('document exceeds max file size');
  return bytes;
}
