import type { JsonValue, SurfaceModel } from './model.js';
import type { DocumentPropertyCapability } from '../documents.js';

function metadata(model: SurfaceModel): Record<string, JsonValue> | null {
  const value = model.unknownFields?.meta;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}

/** Ink and Whiteboard share the same document-level property bag. */
export const surfaceDocumentProperties: DocumentPropertyCapability<SurfaceModel> = {
  key: (propertyId) => propertyId,
  read(model, key) {
    if (model.unknownFields?.meta !== undefined && metadata(model) === null)
      throw new Error('Surface document metadata is unsupported');
    const bag = metadata(model)?.properties;
    if (bag === undefined) return { present: false };
    if (typeof bag !== 'object' || bag === null || Array.isArray(bag))
      throw new Error('Surface properties metadata is unsupported');
    return Object.prototype.hasOwnProperty.call(bag, key)
      ? { present: true, value: (bag as Record<string, JsonValue>)[key]! }
      : { present: false };
  },
  write(model, key, value) {
    if (model.unknownFields?.meta !== undefined && metadata(model) === null)
      throw new Error('Surface document metadata is unsupported');
    const meta = metadata(model);
    const bag = meta?.properties;
    if (bag !== undefined && (typeof bag !== 'object' || bag === null || Array.isArray(bag)))
      throw new Error('Surface properties metadata is unsupported');
    model.unknownFields = {
      ...model.unknownFields,
      meta: { ...meta, properties: { ...(bag as Record<string, JsonValue> | undefined), [key]: value } },
    };
  },
  unset(model, key) {
    if (model.unknownFields?.meta !== undefined && metadata(model) === null)
      throw new Error('Surface document metadata is unsupported');
    const meta = metadata(model);
    const bag = meta?.properties;
    if (bag === undefined) return;
    if (typeof bag !== 'object' || bag === null || Array.isArray(bag))
      throw new Error('Surface properties metadata is unsupported');
    const next = { ...bag };
    delete (next as Record<string, JsonValue>)[key];
    model.unknownFields = { ...model.unknownFields, meta: { ...meta, properties: next } };
  },
};

/** Explicit title stored in the preservation-first surface metadata bag. */
export function surfaceDocumentTitle(model: SurfaceModel): string | null {
  const title = metadata(model)?.title;
  return typeof title === 'string' ? title : null;
}

/** Write only the explicit title while preserving every other unknown field. */
export function writeSurfaceDocumentTitle(
  model: SurfaceModel,
  title: string,
): void {
  model.unknownFields = {
    ...model.unknownFields,
    meta: { ...(metadata(model) ?? {}), title },
  };
}
