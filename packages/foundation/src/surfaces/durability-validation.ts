import { inkSourceOutline } from './ink/source-geometry.js';
import { FroglightError } from '../errors.js';
import { utf8Encode } from '../encoding.js';
import {
  decodeNotebook,
  encodeNotebook,
  notebookPayloadValue,
} from '../notebooks/codec.js';
import type { NotebookModel } from '../notebooks/model.js';
import type { SurfaceDocumentDelta } from '../surface-persistence.js';
import { SURFACE_LIMITS, decodeSurfacePayloadValue } from './codec.js';
import {
  findGeometryLimitViolation,
  isCoreSurfaceObjectType,
  isValidCoreSurfaceObject,
  SURFACE_OBJECT_TYPES,
  type SurfaceModel,
  type SurfaceObjectRecord,
} from './model.js';
import { INK_SOURCE_TYPE, validInkVisible } from './ink/fragment-validation.js';

/** Worker mirrors own immutable units. Cached pretty-JSON sizes never walk unchanged samples. */
export class SurfaceDurabilityValidator {
  readonly #sizes = new WeakMap<object, Map<number, number>>();
  readonly #validated = new WeakSet<object>();
  #bytes(value: unknown, depth = 0): number {
    if (value === null || typeof value !== 'object')
      return utf8Encode(JSON.stringify(value ?? null)).length;
    const cached = this.#sizes.get(value)?.get(depth);
    if (cached !== undefined) return cached;
    const array = Array.isArray(value);
    const entries = array
      ? value.map((v) => ['', v] as const)
      : Object.entries(value).filter(([, v]) => v !== undefined);
    let count = 2;
    if (entries.length > 0) {
      count += 1 + depth * 2;
      entries.forEach(([key, v], index) => {
        count +=
          (depth + 1) * 2 +
          (array ? 0 : utf8Encode(JSON.stringify(key)).length + 2) +
          this.#bytes(v, depth + 1) +
          (index === entries.length - 1 ? 1 : 2);
      });
    }
    const sizes = this.#sizes.get(value) ?? new Map();
    sizes.set(depth, count);
    this.#sizes.set(value, sizes);
    return count;
  }
  #record(record: SurfaceObjectRecord, key: string): void {
    if (
      record.id !== key ||
      typeof record.type !== 'string' ||
      key.length === 0
    )
      throw new FroglightError(
        'RECORD_CORRUPT',
        'Invalid journal object identity',
      );
    if (this.#validated.has(record)) return;
    if (isCoreSurfaceObjectType(record.type)) {
      const violation = findGeometryLimitViolation(record);
      if (violation !== null)
        throw new FroglightError('FORMAT_LIMIT_EXCEEDED', violation);
      if (
        Array.isArray(record.points) &&
        record.points.length > SURFACE_LIMITS.maxStrokePoints
      )
        throw new FroglightError(
          'FORMAT_LIMIT_EXCEEDED',
          'Journal stroke exceeds the sample limit',
        );
      if (
        (record.type === SURFACE_OBJECT_TYPES.text ||
          record.type === SURFACE_OBJECT_TYPES.card) &&
        typeof record.text === 'string' &&
        record.text.length > SURFACE_LIMITS.maxTextLength
      )
        throw new FroglightError(
          'FORMAT_LIMIT_EXCEEDED',
          'Journal text exceeds the text limit',
        );
      if (
        record.type === SURFACE_OBJECT_TYPES.stroke &&
        record.erasure !== undefined
      )
        throw new FroglightError(
          'RECORD_CORRUPT',
          'Unsupported stroke erasure mask; original recovery data is preserved',
        );
      if (record.type === INK_SOURCE_TYPE) {
        if (!isValidCoreSurfaceObject(record))
          throw new FroglightError(
            'RECORD_CORRUPT',
            'Invalid journal ink source',
          );
        inkSourceOutline(record);
        for (const chunk of record.chunks as SurfaceObjectRecord[]) {
          const violation = findGeometryLimitViolation(chunk);
          if (violation !== null)
            throw new FroglightError('FORMAT_LIMIT_EXCEEDED', violation);
        }
      }
      if (
        record.type === SURFACE_OBJECT_TYPES.stroke &&
        record.sourceId !== undefined &&
        !isValidCoreSurfaceObject(record)
      )
        throw new FroglightError(
          'RECORD_CORRUPT',
          'Invalid journal ink fragment',
        );
    }
    this.#validated.add(record);
  }
  validate(
    model: unknown,
    delta: SurfaceDocumentDelta,
    notebook: boolean,
    kindId?: string,
  ): void {
    if (
      kindId === 'froglight.whiteboard' &&
      (model as SurfaceModel).frame.kind !== 'infinite'
    )
      throw new FroglightError(
        'RECORD_CORRUPT',
        'Whiteboard journal frame must be infinite',
      );
    const surfaces = notebook
      ? Object.values((model as NotebookModel).pages).flatMap((p) =>
          p.kind === 'page' ? [p.surface] : [],
        )
      : [model as SurfaceModel];
    for (const surface of surfaces) {
      if (Object.keys(surface.objects).length > SURFACE_LIMITS.maxObjects)
        throw new FroglightError(
          'FORMAT_LIMIT_EXCEEDED',
          'Journal exceeds the Surface object limit',
        );
      // Envelope validation is independent of ink samples and source geometry.
      decodeSurfacePayloadValue({ ...surface, objects: {}, order: [] });
      const seen = new Set<string>();
      for (const id of surface.order) {
        if (
          seen.has(id) ||
          surface.objects[id] === undefined ||
          surface.objects[id]?.type === INK_SOURCE_TYPE
        )
          throw new FroglightError(
            'RECORD_CORRUPT',
            'Invalid journal paint order',
          );
        seen.add(id);
      }
      for (const [id, record] of Object.entries(surface.objects)) {
        this.#record(record, id);
        if (record.type !== INK_SOURCE_TYPE && !seen.has(id))
          throw new FroglightError(
            'RECORD_CORRUPT',
            'Journal object is absent from paint order',
          );
        if (
          record.type === SURFACE_OBJECT_TYPES.stroke &&
          record.sourceId !== undefined
        ) {
          const source = surface.objects[record.sourceId as string];
          if (
            source?.type !== INK_SOURCE_TYPE ||
            !validInkVisible(record.visible, source.outlineLength as number)
          )
            throw new FroglightError(
              'RECORD_CORRUPT',
              'Unresolved journal ink boundary',
            );
        }
      }
    }
    for (const change of delta.surfaces)
      for (const [id, record] of Object.entries({
        ...change.objects,
        ...change.drafts,
      }))
        if (record !== null) this.#record(record, id);
    if (notebook) {
      const root = model as NotebookModel;
      // Validate container structure with empty surface objects, preserving every shell field.
      const skeleton = {
        ...root,
        pages: Object.fromEntries(
          Object.entries(root.pages).map(([id, p]) => [
            id,
            p.kind === 'page'
              ? { ...p, surface: { ...p.surface, objects: {}, order: [] } }
              : p,
          ]),
        ),
      };
      decodeNotebook(encodeNotebook(skeleton));
    }
    const root = model as SurfaceModel;
    const payload = notebook
      ? notebookPayloadValue(model as NotebookModel)
      : (() => {
          const { unknownFields, ...known } = root;
          return { ...known, ...unknownFields };
        })();
    if (this.#bytes(payload) + 1 > SURFACE_LIMITS.maxFileBytes)
      throw new FroglightError(
        'FORMAT_LIMIT_EXCEEDED',
        'This edit exceeds the document file-size limit; previous durable content is retained',
      );
  }
}
